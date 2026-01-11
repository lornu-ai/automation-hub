import * as jose from "jose";
import { indexAllDocuments, searchVectorize, getIndexStatus } from "./vectorize_indexer";

export interface Env {
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  AI_AGENT_ENDPOINT: string;
  AI_AGENT_TOKEN: string;
  WEBHOOK_SECRET?: string;
  // Issue #565: Private RAG Grounding bindings
  PRIVATE_RAG_BUCKET: R2Bucket;
  LORNU_VECTORIZE: VectorizeIndex;
  AI: Ai;
  VECTORIZE_API_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    console.log(`Incoming request: ${request.method} ${url.pathname} from ${request.headers.get("User-Agent")}`);
    console.log(`Event: ${request.headers.get("X-GitHub-Event")}, Signature: ${request.headers.get("X-Hub-Signature-256") ? "Present" : "Missing"}`);
    if (url.pathname === "/healthz" || url.pathname === "/health") {
      return new Response("OK", { status: 200 });
    }

    // Issue #565: Vectorize/RAG API endpoints
    if (url.pathname === "/api/vectorize/trigger" && request.method === "POST") {
      return await handleVectorizeTrigger(request, env);
    }

    if (url.pathname === "/api/rag/search" && request.method === "POST") {
      return await handleRagSearch(request, env);
    }

    if (url.pathname === "/api/vectorize/status" && request.method === "GET") {
      return await handleVectorizeStatus(env);
    }

    // Only handle POST requests for webhooks
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const eventType = request.headers.get("X-GitHub-Event");
    const signature = request.headers.get("X-Hub-Signature-256");

    // Read body once
    const bodyText = await request.text();

    // Verify signature if WEBHOOK_SECRET is set
    if (env.WEBHOOK_SECRET) {
      if (!signature) {
        return new Response("Missing Signature", { status: 401 });
      }
      const isValid = await verifySignature(bodyText, signature, env.WEBHOOK_SECRET);
      if (!isValid) {
        return new Response("Invalid Signature", { status: 401 });
      }
    }

    try {
      const payload = JSON.parse(bodyText);

      if (eventType === "pull_request") {
        return await handlePullRequest(payload, env);
      }

      return new Response(JSON.stringify({
        status: "accepted",
        message: `Event ${eventType} received.`
      }), {
        status: 202,
        headers: { "Content-Type": "application/json" }
      });
    } catch (error: any) {
      console.error("Worker error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
  }
};

/**
 * Generate a GitHub Installation Access Token (IAT)
 */
async function getInstallationToken(env: Env, installationId: string): Promise<string> {
  const privateKey = await jose.importPKCS8(env.GITHUB_PRIVATE_KEY, "RS256");

  const jwt = await new jose.SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .setIssuer(env.GITHUB_APP_ID)
    .sign(privateKey);

  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${jwt}`,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "Lornu-Automation-Hub"
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${errorBody}`);
  }

  const data = await response.json() as { token: string };
  return data.token;
}

/**
 * Verify HMAC SHA-256 signature from GitHub in a timing-safe manner
 */
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(secret);
  const dataBytes = encoder.encode(body);

  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, dataBytes);

  // Convert provided signature hex to Uint8Array
  const providedHex = signature.slice(7);
  if (providedHex.length !== 64) return false;

  const providedBytes = new Uint8Array(providedHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

  // Timing-safe comparison using bitwise XOR
  if (signatureBuffer.byteLength !== providedBytes.byteLength) return false;

  const a = new Uint8Array(signatureBuffer);
  const b = providedBytes;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

async function handlePullRequest(payload: any, env: Env): Promise<Response> {
  const action = payload.action;
  const prNumber = payload.pull_request?.number;
  const repository = payload.repository?.full_name;
  const installationId = payload.installation?.id;

  if (!prNumber || !repository || !installationId) {
    return new Response("Invalid PR payload (missing PR info or installation ID)", { status: 400 });
  }

  // Only review on opened or synchronize (new commits)
  if (action !== "opened" && action !== "synchronize") {
    return new Response(JSON.stringify({
      status: "ignored",
      message: `Action ${action} ignored.`
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    });
  }

  console.log(`Processing PR #${prNumber} for ${repository} (Action: ${action})`);

  try {
    // 0. Get dynamic installation token for this repo
    const githubToken = await getInstallationToken(env, installationId.toString());

    // 1. Fetch PR Diff using GitHub API
    const diffResponse = await fetch(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
      headers: {
        "Authorization": `token ${githubToken}`,
        "Accept": "application/vnd.github.v3.diff",
        "User-Agent": "Lornu-Automation-Hub"
      }
    });

    if (!diffResponse.ok) {
      throw new Error(`Failed to fetch diff: ${diffResponse.statusText}`);
    }

    const diff = await diffResponse.text();

    // 2. Call AI Agent
    const agentResponse = await fetch(env.AI_AGENT_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.AI_AGENT_TOKEN}`,
        "Content-Type": "text/plain",
        "X-PR-Number": prNumber.toString(),
        "X-PR-Repository": repository
      },
      body: diff
    });

    if (!agentResponse.ok) {
      const errorText = await agentResponse.text();
      throw new Error(`AI Agent failed: ${agentResponse.status} - ${errorText}`);
    }

    const result = await agentResponse.json() as any;
    const reviewBody = result.body || result.message || "AI Review completed but no body returned.";

    // 3. Post Comment to GitHub
    const commentResponse = await fetch(`https://api.github.com/repos/${repository}/issues/${prNumber}/comments`, {
      method: "POST",
      headers: {
        "Authorization": `token ${githubToken}`,
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Lornu-Automation-Hub"
      },
      body: JSON.stringify({ body: reviewBody })
    });

    if (!commentResponse.ok) {
      throw new Error(`Failed to post comment: ${commentResponse.statusText}`);
    }

    return new Response(JSON.stringify({ status: "success", message: "Review posted." }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error: any) {
    console.error(`Error processing PR #${prNumber}:`, error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
}

/**
 * Issue #565: Handle Vectorize index trigger requests
 * Called by LibrarianAgent CronJob to rebuild the index
 */
async function handleVectorizeTrigger(request: Request, env: Env): Promise<Response> {
  // Verify authorization
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing or invalid authorization" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const token = authHeader.slice(7);
  if (env.VECTORIZE_API_TOKEN && token !== env.VECTORIZE_API_TOKEN) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await request.json() as { action?: string };
    const action = body.action || "full_rebuild";

    console.log(`Vectorize trigger received: action=${action}`);

    if (action === "full_rebuild") {
      const result = await indexAllDocuments(env);
      return new Response(JSON.stringify({
        status: "success",
        message: "Full index rebuild completed",
        details: result
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      status: "accepted",
      message: `Action ${action} received`
    }), {
      status: 202,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error: any) {
    console.error("Vectorize trigger error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Issue #565: Handle RAG search requests
 * Called by LibrarianAgent for semantic document search
 */
async function handleRagSearch(request: Request, env: Env): Promise<Response> {
  // Verify authorization
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Missing or invalid authorization" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  const token = authHeader.slice(7);
  if (env.VECTORIZE_API_TOKEN && token !== env.VECTORIZE_API_TOKEN) {
    return new Response(JSON.stringify({ error: "Invalid token" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await request.json() as {
      query: string;
      top_k?: number;
      filter_metadata?: Record<string, string>;
    };

    if (!body.query) {
      return new Response(JSON.stringify({ error: "Query is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const results = await searchVectorize(
      env,
      body.query,
      body.top_k || 5,
      body.filter_metadata
    );

    return new Response(JSON.stringify({
      status: "success",
      results
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error: any) {
    console.error("RAG search error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

/**
 * Issue #565: Handle Vectorize status requests
 * Returns current index status and statistics
 */
async function handleVectorizeStatus(env: Env): Promise<Response> {
  try {
    const status = await getIndexStatus(env);
    return new Response(JSON.stringify({
      status: "success",
      index: status
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error: any) {
    console.error("Vectorize status error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
