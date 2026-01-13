/**
 * OIDC Sovereign Relay Hub - Cloudflare Worker
 * Endpoint: oidc-hub.dockworker.ai
 *
 * Implements Issue #24: https://github.com/lornu-ai/dockworker.ai/issues/24
 *
 * This Hub:
 * 1. Exposes OIDC Discovery and JWKS endpoints (which Azure/AWS/GCP will poll)
 * 2. Issues short-lived tokens when triggered by authenticated requests
 */

import * as jose from 'jose';

export interface Env {
  // Use `wrangler secret put PRIVATE_KEY` to store a PKCS#8 private key
  PRIVATE_KEY: string;
  ISSUER_URL: string; // e.g., "https://oidc-hub.dockworker.ai"
  ALLOWED_AUDIENCE?: string; // Optional: default audience for token exchange
  MINT_API_KEY?: string; // Required for /mint endpoint authentication
  KEY_ID?: string; // Optional: Key ID for JWKS (default: derived from key)
  TOKEN_EXPIRATION?: string; // Optional: Token expiration (default: "15m")
}

// Cache for imported private key to avoid re-parsing on each request
let cachedPrivateKey: jose.KeyLike | null = null;
let cachedKeyId: string | null = null;

async function getPrivateKey(env: Env): Promise<jose.KeyLike> {
  if (!cachedPrivateKey) {
    cachedPrivateKey = await jose.importPKCS8(env.PRIVATE_KEY, 'RS256');
  }
  return cachedPrivateKey;
}

async function getKeyId(env: Env): Promise<string> {
  if (!cachedKeyId) {
    if (env.KEY_ID) {
      cachedKeyId = env.KEY_ID;
    } else {
      // Derive key ID from public key thumbprint for easier rotation
      const privateKey = await getPrivateKey(env);
      const jwk = await jose.exportJWK(privateKey);
      cachedKeyId = await jose.calculateJwkThumbprint(jwk, 'sha256');
    }
  }
  return cachedKeyId;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 1. OIDC Discovery Endpoint
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: env.ISSUER_URL,
        jwks_uri: `${env.ISSUER_URL}/.well-known/jwks.json`,
        response_types_supported: ['id_token'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'email', 'roles']
      });
    }

    // 2. JWKS Endpoint (Public Keys for Azure/AWS/GCP)
    if (url.pathname === '/.well-known/jwks.json') {
      try {
        const privateKey = await getPrivateKey(env);
        const keyId = await getKeyId(env);
        const jwk = await jose.exportJWK(privateKey);
        return Response.json({
          keys: [{
            ...jwk,
            kid: keyId,
            use: 'sig',
            alg: 'RS256'
          }]
        });
      } catch {
        // Don't expose internal error details
        return new Response(
          JSON.stringify({ error: 'Failed to generate JWKS' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // 3. Token Minting (The "Hub" Logic)
    if (url.pathname === '/mint' && request.method === 'POST') {
      // Authentication: Require API key or Cloudflare Access JWT
      const authHeader = request.headers.get('Authorization');
      const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

      // Check for API key authentication
      if (!env.MINT_API_KEY) {
        return new Response(
          JSON.stringify({ error: 'Service not configured: MINT_API_KEY required' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (!apiKey || apiKey !== env.MINT_API_KEY) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized: Invalid or missing API key' }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }

      try {
        const privateKey = await getPrivateKey(env);
        const keyId = await getKeyId(env);

        // Parse request body - require explicit claims, no dangerous defaults
        let requestBody: { subject?: string; audience?: string; claims?: Record<string, unknown> };
        try {
          requestBody = await request.json();
        } catch {
          return new Response(
            JSON.stringify({ error: 'Invalid request body: Expected JSON' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Validate required fields
        if (!requestBody.subject) {
          return new Response(
            JSON.stringify({ error: 'Missing required field: subject' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        // Build claims without dangerous defaults (no admin role)
        const customClaims: Record<string, unknown> = {
          ...requestBody.claims,
        };

        const expiration = env.TOKEN_EXPIRATION || '15m';
        const audience = requestBody.audience || env.ALLOWED_AUDIENCE;

        if (!audience) {
          return new Response(
            JSON.stringify({ error: 'Missing required field: audience (or set ALLOWED_AUDIENCE)' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          );
        }

        const jwt = await new jose.SignJWT(customClaims)
          .setProtectedHeader({ alg: 'RS256', kid: keyId })
          .setIssuedAt()
          .setIssuer(env.ISSUER_URL)
          .setAudience(audience)
          .setSubject(requestBody.subject)
          .setExpirationTime(expiration)
          .sign(privateKey);

        return Response.json({ id_token: jwt, token_type: 'Bearer', expires_in: expiration });
      } catch {
        // Don't expose internal error details
        return new Response(
          JSON.stringify({ error: 'Token minting failed' }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // Health check endpoint
    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json({
        status: 'operational',
        service: 'oidc-hub',
        issuer: env.ISSUER_URL,
        endpoints: {
          discovery: '/.well-known/openid-configuration',
          jwks: '/.well-known/jwks.json',
          mint: '/mint'
        }
      });
    }

    return new Response('Not Found', { status: 404 });
  }
};
