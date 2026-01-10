"""
AI-powered code review logic.
"""
import os
import re
import json
import fnmatch
from typing import Dict, Any, List, Optional
from openai import AsyncOpenAI
from anthropic import AsyncAnthropic


class CodeReviewer:
    """AI-powered code reviewer using OpenAI or Claude."""
    
    def __init__(
        self,
        provider: str = "openai",
        model: Optional[str] = None
    ):
        """
        Initialize code reviewer.
        
        Args:
            provider: AI provider ("openai" or "claude")
            model: Model name (defaults based on provider)
        """
        self.provider = provider.lower()
        
        if self.provider == "openai":
            api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                raise ValueError("OPENAI_API_KEY environment variable is required")
            self.client = AsyncOpenAI(api_key=api_key)
            self.model = model or os.getenv("OPENAI_MODEL", "gpt-4o")
        elif self.provider == "claude":
            api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                raise ValueError("ANTHROPIC_API_KEY environment variable is required")
            self.client = AsyncAnthropic(api_key=api_key)
            self.model = model or os.getenv("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")
        else:
            raise ValueError(f"Unsupported provider: {provider}")
    
    def _build_system_prompt(self) -> str:
        """Build system prompt for code review."""
        return """You are an expert code reviewer for the Lornu AI platform. Your role is to analyze pull requests from the private-lornu-ai repository and provide constructive, actionable feedback.

Focus Areas:
1. Security vulnerabilities (OWASP Top 10, secret exposure, injection attacks)
2. Logic errors and edge cases
3. Performance optimizations
4. Code style and maintainability
5. Best practices for Python/FastAPI, TypeScript/React, Kubernetes, and infrastructure-as-code

Review Guidelines:
- Be specific: Reference file paths and line numbers
- Be constructive: Suggest fixes, not just problems
- Prioritize: Focus on critical issues first
- Be concise: Keep comments brief and actionable
- Follow the project's coding standards

Output Format:
Return a JSON object with:
{
  "summary": "High-level review summary",
  "security_score": 0-100,
  "comments": [
    {
      "path": "relative/file/path",
      "line": 42,
      "message": "Comment text (markdown)",
      "severity": "error|warning|info"
    }
  ]
}

Note: The 'comments' array should contain detailed feedback for specific files/lines.
Use 'path' for the file path (relative to repository root).
Use 'line' for the line number (integer).
Use 'message' for the comment text.
Use 'severity' to indicate issue level: 'error' (critical), 'warning' (should fix), 'info' (suggestion)."""
    
    async def review_diff(
        self,
        diff: str,
        pr_title: str,
        pr_description: Optional[str] = None,
        max_files: Optional[int] = None,
        exclude_patterns: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """
        Review code diff using AI.
        
        Args:
            diff: PR diff string
            pr_title: PR title
            pr_description: PR description/body
            max_files: Maximum number of files to review (None = all)
            exclude_patterns: File patterns to exclude (e.g., ["*.lock", "dist/*"])
            
        Returns:
            Review results with summary, security score, and comments
        """
        # Filter diff if needed
        filtered_diff = self._filter_diff(diff, exclude_patterns, max_files)
        
        # Build prompt
        user_prompt = f"""Review this pull request:

Title: {pr_title}
Description: {pr_description or "No description provided"}

Diff:
{filtered_diff}

Provide a comprehensive code review focusing on security, logic, performance, and maintainability."""
        
        system_prompt = self._build_system_prompt()
        
        # Call AI
        if self.provider == "openai":
            response = await self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"},
                temperature=0.3
            )
            result_text = response.choices[0].message.content
        else:  # Claude
            # Claude doesn't support structured output like OpenAI, so we request JSON in the prompt
            json_prompt = f"{user_prompt}\n\nIMPORTANT: Respond with valid JSON only. Use this exact format:\n{{\n  \"summary\": \"review summary\",\n  \"security_score\": 85,\n  \"comments\": [{{\"path\": \"file.py\", \"line\": 42, \"message\": \"comment\", \"severity\": \"warning\"}}]\n}}"
            response = await self.client.messages.create(
                model=self.model,
                max_tokens=4096,
                system=f"{system_prompt}\n\nYou must respond with valid JSON only. No markdown, no explanation, just the JSON object.",
                messages=[
                    {"role": "user", "content": json_prompt}
                ]
            )
            result_text = response.content[0].text
            # Extract JSON from response if it's wrapped in markdown code blocks
            json_match = re.search(r'```(?:json)?\s*(\{.*\})\s*```', result_text, re.DOTALL)
            if json_match:
                result_text = json_match.group(1)
            else:
                # Try to find JSON object directly
                json_match = re.search(r'\{.*\}', result_text, re.DOTALL)
                if json_match:
                    result_text = json_match.group(0)
        
        # Parse JSON response
        try:
            result = json.loads(result_text)
        except json.JSONDecodeError:
            # Fallback if AI doesn't return valid JSON
            result = {
                "summary": result_text[:500],
                "security_score": 75,
                "comments": []
            }
        
        return result
    
    def _filter_diff(
        self,
        diff: str,
        exclude_patterns: Optional[List[str]],
        max_files: Optional[int]
    ) -> str:
        """
        Filter diff based on exclude patterns and max files.
        
        Args:
            diff: Original diff
            exclude_patterns: Patterns to exclude
            max_files: Maximum number of files
            
        Returns:
            Filtered diff
        """
        if not exclude_patterns and not max_files:
            return diff
        
        lines = diff.split("\n")
        filtered_lines = []
        current_file = None
        file_count = 0
        
        for line in lines:
            # Check if this is a file header
            if line.startswith("diff --git") or line.startswith("--- a/") or line.startswith("+++ b/"):
                # Extract filename
                if line.startswith("+++ b/"):
                    # More robust parsing: everything after "+++ b/"
                    filename = line[6:].strip()
                    
                    # Check exclude patterns
                    if exclude_patterns:
                        if any(fnmatch.fnmatch(filename, pattern) for pattern in exclude_patterns):
                            current_file = None
                            continue
                    
                    # Check max files
                    if max_files and file_count >= max_files:
                        break
                    
                    file_count += 1
                    current_file = filename
            
            if current_file is not None:
                filtered_lines.append(line)
        
        return "\n".join(filtered_lines)
