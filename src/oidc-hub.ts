/**
 * OIDC Sovereign Relay Hub - Cloudflare Worker
 * Endpoint: oidc-hub.dockworker.ai
 * 
 * Implements Issue #24: https://github.com/lornu-ai/dockworker.ai/issues/24
 * 
 * This Hub:
 * 1. Exposes OIDC Discovery and JWKS endpoints (which Azure/AWS/GCP will poll)
 * 2. Issues short-lived tokens when triggered by a valid secret or GitHub Action
 */

import * as jose from 'jose';

export interface Env {
  // Use `wrangler secret put PRIVATE_KEY` to store a PKCS#8 or JWK private key
  PRIVATE_KEY: string;
  ISSUER_URL: string; // e.g., "https://oidc-hub.dockworker.ai"
  ALLOWED_AUDIENCE?: string; // Optional: default audience for token exchange
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
        const privateKey = await jose.importPKCS8(env.PRIVATE_KEY, 'RS256');
        const jwk = await jose.exportJWK(privateKey);
        return Response.json({
          keys: [{
            ...jwk,
            kid: 'lornu-key-1',
            use: 'sig',
            alg: 'RS256'
          }]
        });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Failed to generate JWKS', details: String(error) }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    // 3. Token Minting (The "Hub" Logic)
    if (url.pathname === '/mint' && request.method === 'POST') {
      try {
        // Logic: Validate the incoming request (e.g., Check for a Service Token or GitHub JWT)
        // For this example, we'll assume the request is pre-cleared by Cloudflare Access.
        // In production, add proper authentication/authorization here.

        const privateKey = await jose.importPKCS8(env.PRIVATE_KEY, 'RS256');

        // Extract claims from request body if provided, otherwise use defaults
        let customClaims: Record<string, any> = {
          is_charles: true,
          environment: 'develop',
          roles: ['admin']
        };

        try {
          const body = await request.json();
          if (body.claims) {
            customClaims = { ...customClaims, ...body.claims };
          }
          if (body.subject) {
            customClaims.sub = body.subject;
          }
          if (body.audience) {
            customClaims.aud = body.audience;
          }
        } catch {
          // Use default claims if body parsing fails
        }

        const jwt = await new jose.SignJWT(customClaims)
          .setProtectedHeader({ alg: 'RS256', kid: 'lornu-key-1' })
          .setIssuedAt()
          .setIssuer(env.ISSUER_URL)
          .setAudience(customClaims.aud || env.ALLOWED_AUDIENCE || 'api://AzureADTokenExchange')
          .setSubject(customClaims.sub || 'repo:lornu-ai/private-lornu-ai:ref:refs/heads/develop')
          .setExpirationTime('1h')
          .sign(privateKey);

        return Response.json({ id_token: jwt, token_type: 'Bearer' });
      } catch (error) {
        return new Response(
          JSON.stringify({ error: 'Token minting failed', details: String(error) }),
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
