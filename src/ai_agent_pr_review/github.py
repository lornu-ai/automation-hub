"""
GitHub API client for fetching PR diffs and posting review comments.
"""
import os
from typing import Dict, Any, List, Optional
import httpx


class GitHubClient:
    """Client for interacting with GitHub API."""
    
    def __init__(self, token: Optional[str] = None):
        """
        Initialize GitHub client.
        
        Args:
            token: GitHub personal access token or installation token.
                  If None, reads from GITHUB_TOKEN environment variable.
        """
        self.token = token or os.getenv("GITHUB_TOKEN")
        if not self.token:
            raise ValueError("GitHub token is required (GITHUB_TOKEN env var or token parameter)")
        
        self.base_url = "https://api.github.com"
        self.headers = {
            "Authorization": f"token {self.token}",
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Lornu-AI-PR-Reviewer/1.0"
        }
        self.client = httpx.AsyncClient(base_url=self.base_url, headers=self.headers)
    
    async def close(self):
        """Close the underlying httpx client."""
        await self.client.aclose()
    
    async def get_pr_diff(
        self,
        owner: str,
        repo: str,
        pull_number: int
    ) -> str:
        """
        Fetch PR diff from GitHub API.
        
        Args:
            owner: Repository owner (e.g., "lornu-ai")
            repo: Repository name (e.g., "private-lornu-ai")
            pull_number: PR number
            
        Returns:
            PR diff as string
        """
        # Fetch PR diff
        response = await self.client.get(
            f"/repos/{owner}/{repo}/pulls/{pull_number}",
            headers={"Accept": "application/vnd.github.v3.diff"}
        )
        response.raise_for_status()
        return response.text
    
    async def get_pr_patch(
        self,
        owner: str,
        repo: str,
        pull_number: int
    ) -> str:
        """
        Fetch PR patch from GitHub API (alternative to diff).
        
        Args:
            owner: Repository owner
            repo: Repository name
            pull_number: PR number
            
        Returns:
            PR patch as string
        """
        response = await self.client.get(
            f"/repos/{owner}/{repo}/pulls/{pull_number}",
            headers={"Accept": "application/vnd.github.v3.patch"}
        )
        response.raise_for_status()
        return response.text
    
    async def post_review_comment(
        self,
        owner: str,
        repo: str,
        pull_number: int,
        body: str,
        commit_id: str,
        path: str,
        line: Optional[int] = None,
        side: str = "RIGHT"
    ) -> Dict[str, Any]:
        """
        Post an inline review comment on a PR.
        
        Args:
            owner: Repository owner
            repo: Repository name
            pull_number: PR number
            body: Comment body (markdown)
            commit_id: SHA of the commit to comment on
            path: Relative path of the file
            line: Line number (optional, for inline comments)
            side: "LEFT" (deleted line) or "RIGHT" (added line)
            
        Returns:
            Created comment data
        """
        comment_data = {
            "body": body,
            "commit_id": commit_id,
            "path": path,
            "side": side
        }
        
        if line is not None:
            comment_data["line"] = line
        
        response = await self.client.post(
            f"/repos/{owner}/{repo}/pulls/{pull_number}/comments",
            json=comment_data
        )
        response.raise_for_status()
        return response.json()
    
    async def post_review(
        self,
        owner: str,
        repo: str,
        pull_number: int,
        body: str,
        event: str = "COMMENT",
        comments: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Post a PR review (summary-level review).
        
        Args:
            owner: Repository owner
            repo: Repository name
            pull_number: PR number
            body: Review body (markdown summary)
            event: Review event ("APPROVE", "REQUEST_CHANGES", "COMMENT")
            comments: Optional list of inline comments
            
        Returns:
            Created review data
        """
        review_data = {
            "body": body,
            "event": event
        }
        
        if comments:
            review_data["comments"] = comments
        
        response = await self.client.post(
            f"/repos/{owner}/{repo}/pulls/{pull_number}/reviews",
            json=review_data
        )
        response.raise_for_status()
        return response.json()
    
    async def get_pr_details(
        self,
        owner: str,
        repo: str,
        pull_number: int
    ) -> Dict[str, Any]:
        """
        Get PR details.
        
        Args:
            owner: Repository owner
            repo: Repository name
            pull_number: PR number
            
        Returns:
            PR data
        """
        response = await self.client.get(
            f"/repos/{owner}/{repo}/pulls/{pull_number}"
        )
        response.raise_for_status()
        return response.json()
