import os
import re
import httpx
import secrets
import logging
from fastapi import FastAPI, Request, HTTPException, Header
from typing import Any, Dict, Optional

from .reviewer import CodeReviewer
from .github import GitHubClient

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI PR Reviewer Agent")

# Environment variables
GOOGLE_CHAT_WEBHOOK = os.environ.get("GOOGLE_CHAT_WEBHOOK")
LINEAR_API_KEY = os.environ.get("LINEAR_API_KEY")
AUTH_TOKEN = os.environ.get("AUTH_TOKEN")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN")
AI_PROVIDER = os.environ.get("AI_PROVIDER", "openai")

# Initialize clients
reviewer = CodeReviewer(provider=AI_PROVIDER)

if not GITHUB_TOKEN:
    # Fail fast with a clear message if GitHub integration is required but misconfigured.
    raise RuntimeError(
        "GITHUB_TOKEN environment variable is not set. "
        "This service requires a GitHub token for PR review. "
        "Please configure GITHUB_TOKEN and restart the application."
    )
gh_client = GitHubClient(token=GITHUB_TOKEN)

async def notify_stakeholders(pr: Dict[str, Any], review_summary: str):
    """
    Sends notifications to Google Chat and updates Linear issues.
    Translated from TypeScript requirement in Issue #283.
    """
    async with httpx.AsyncClient() as client:
        # 1. GOOGLE CHAT: Send a high-level summary to the team space
        if GOOGLE_CHAT_WEBHOOK:
            chat_payload = {
                "text": f"🤖 *AI Review Complete for PR #{pr.get('number')}*\n> {review_summary}\nView PR: {pr.get('html_url')}"
            }
            try:
                await client.post(GOOGLE_CHAT_WEBHOOK, json=chat_payload)
            except Exception as e:
                logger.error(f"Error notifying Google Chat: {e}", exc_info=True)

        # 2. LINEAR: Find the linked issue and post a "Review Done" comment
        if LINEAR_API_KEY:
            # Extract Issue ID (e.g., LOR-123) from PR title
            title = pr.get("title", "")
            match = re.search(r"([A-Z]+-\d+)", title)
            if match:
                issue_key = match.group(1)
                
                # First, resolve the human-readable issue key to Linear's internal database ID (UUID)
                issue_id = None
                issue_lookup_query = """
                query IssueByKey($key: String!) {
                    issue(key: $key) {
                        id
                    }
                }
                """
                headers = {
                    "Authorization": LINEAR_API_KEY,
                    "Content-Type": "application/json"
                }
                
                try:
                    lookup_response = await client.post(
                        "https://api.linear.app/graphql",
                        json={"query": issue_lookup_query, "variables": {"key": issue_key}},
                        headers=headers
                    )
                    lookup_response.raise_for_status()
                    lookup_data = lookup_response.json()
                    issue_node = (lookup_data.get("data") or {}).get("issue")
                    issue_id = issue_node.get("id") if issue_node else None
                except Exception as e:
                    logger.error(f"Error looking up Linear issue ID for key {issue_key}: {e}", exc_info=True)

                if issue_id:
                    linear_query = """
                    mutation CreateComment($issueId: String!, $body: String!) {
                        commentCreate(input: { issueId: $issueId, body: $body }) {
                            success
                        }
                    }
                    """
                    variables = {
                        "issueId": issue_id,
                        "body": f"🤖 AI Agent has finished reviewing the linked PR (#{pr.get('number')}). Summary: {review_summary}"
                    }
                    try:
                        comment_response = await client.post(
                            "https://api.linear.app/graphql",
                            json={"query": linear_query, "variables": variables},
                            headers=headers
                        )
                        comment_response.raise_for_status()
                    except Exception as e:
                        logger.error(f"Error notifying Linear: {e}", exc_info=True)


@app.post("/review")
async def review_pr(
    request: Request,
    x_pr_number: Optional[int] = Header(None),
    x_pr_repository: Optional[str] = Header(None)
):
    # Verify Auth Token
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    # Security: Reject requests if AUTH_TOKEN is not configured
    if not AUTH_TOKEN:
        logger.critical("AUTH_TOKEN is not configured on the server")
        raise HTTPException(status_code=500, detail="Internal server error: Auth not configured")

    # Extract token more robustly (handle multiple spaces after "Bearer")
    token = auth_header.split(" ", 1)[1].strip()
    if not secrets.compare_digest(token, AUTH_TOKEN):
        raise HTTPException(status_code=401, detail="Unauthorized")

    # Read diff from body (HEAD logic: expect raw diff)
    try:
        diff_content = (await request.body()).decode("utf-8")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request body")
    
    if not diff_content:
        raise HTTPException(status_code=400, detail="Empty diff provided")

    # Fetch PR metadata if possible - check both Header and custom headers
    pr_title = "Unknown PR"
    pr_description = ""
    pr_url = ""
    pr_number = x_pr_number
    pr_repository = x_pr_repository
    
    # Also check custom headers (from workflow)
    if not pr_number:
        pr_number = request.headers.get("X-PR-Number")
        if pr_number:
            try:
                pr_number = int(pr_number)
            except (ValueError, TypeError):
                pr_number = None
    
    if not pr_repository:
        pr_repository = request.headers.get("X-PR-Repository")
    
    if pr_number and pr_repository:
        try:
            repo_parts = pr_repository.split("/")
            if len(repo_parts) == 2:
                owner, repo = repo_parts
                pr_data = await gh_client.get_pr_details(owner, repo, pr_number)
                pr_title = pr_data.get("title", pr_title)
                pr_description = pr_data.get("body", "")
                pr_url = pr_data.get("html_url", "")
            else:
                logger.warning(f"Invalid repository format: {pr_repository}")
        except Exception as e:
            logger.error(f"Error fetching PR details for {pr_repository}#{pr_number}: {e}", exc_info=True)
    
    # Perform AI Review
    try:
        review_results = await reviewer.review_diff(
            diff=diff_content,
            pr_title=pr_title,
            pr_description=pr_description
        )
    except Exception as e:
        logger.error(f"AI Review failed: {e}")
        raise HTTPException(status_code=500, detail=f"AI Review failed: {str(e)}")
    
    # Extract results
    summary = review_results.get("summary", "No summary provided.")
    security_score = review_results.get("security_score", "N/A")
    comments = review_results.get("comments", [])
    
    # Format body
    body = f"### 🤖 Lornu AI Code Review\n\n"
    body += f"**Summary:** {summary}\n\n"
    body += f"**Security Score:** `{security_score}/100` 🛡️\n\n"
    
    if comments:
        body += "#### 📝 Detailed Feedback\n\n"
        for comment in comments:
            severity = comment.get("severity", "info")
            emoji = "🔴" if severity == "error" else "🟡" if severity == "warning" else "ℹ️"
            # Handle both 'file' and 'path' keys, and 'message' and 'body' keys
            file_path = comment.get("path") or comment.get("file", "unknown")
            line_num = comment.get("line", "?")
            comment_text = comment.get("message") or comment.get("body", "No comment")
            body += f"- {emoji} **{file_path}** (Line {line_num}): {comment_text}\n"
    
    # Notify stakeholders
    pr_details = {
        "number": pr_number or x_pr_number,
        "title": pr_title,
        "html_url": pr_url
    }
    await notify_stakeholders(pr_details, summary)
    
    return {"body": body}

@app.get("/healthz")
async def healthz():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
