"""
GitHub Webhook signature validation and payload parsing.
"""
import hmac
import hashlib
from typing import Optional
from fastapi import Request, HTTPException


def verify_github_signature(
    payload_body: bytes,
    signature_header: Optional[str],
    secret: str
) -> bool:
    """
    Verify GitHub webhook signature using HMAC SHA-256.
    
    Args:
        payload_body: Raw request body bytes
        signature_header: X-Hub-Signature-256 header value (format: sha256=<hash>)
        secret: GitHub webhook secret
        
    Returns:
        True if signature is valid, False otherwise
    """
    if not signature_header:
        return False
    
    # Extract hash from header (format: sha256=<hash>)
    if not signature_header.startswith("sha256="):
        return False
    
    expected_hash = signature_header[7:]  # Remove "sha256=" prefix
    
    # Compute HMAC SHA-256
    computed_hash = hmac.new(
        secret.encode("utf-8"),
        payload_body,
        hashlib.sha256
    ).hexdigest()
    
    # Constant-time comparison to prevent timing attacks
    return hmac.compare_digest(computed_hash, expected_hash)


def validate_webhook_request(
    request: Request,
    payload_body: bytes,
    webhook_secret: str
) -> bool:
    """
    Validate GitHub webhook request signature.
    
    Args:
        request: FastAPI request object
        payload_body: Raw request body bytes
        webhook_secret: GitHub webhook secret from environment
        
    Returns:
        True if signature is valid, False otherwise
    """
    signature = request.headers.get("X-Hub-Signature-256")
    return verify_github_signature(
        payload_body,
        signature,
        webhook_secret
    )
