/**
 * Cloudflare Worker for automation-hub
 * Handles GitHub webhooks and orchestrates CI/CD tasks.
 */

export interface Env {
  GITHUB_TOKEN: string;
  AI_AGENT_ENDPOINT: string;
  AI_AGENT_TOKEN: string;
  WEBHOOK_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/healthz" || url.pathname === "/health") {
      return new Response("OK", { status: 200 });
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

      return new Response(JSON.stringify({ message: `Event ${eventType} received but not processed.` }), {
        status: 200,
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
 * Verify HMAC SHA-256 signature from GitHub
 */
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
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

  const signatureBytes = await crypto.subtle.sign("HMAC", key, dataBytes);
  const signatureHex = Array.from(new Uint8Array(signatureBytes))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  const expectedSignature = `sha256=${signatureHex}`;

  // Use a constant-time comparison or just compare strings for now
  return signature === expectedSignature;
}

async function handlePullRequest(payload: any, env: Env): Promise<Response> {
  const action = payload.action;
  const prNumber = payload.pull_request?.number;
  const repository = payload.repository?.full_name;

  if (!prNumber || !repository) {
    return new Response("Invalid PR payload", { status: 400 });
  }

  // Only review on opened or synchronize (new commits)
  if (action !== "opened" && action !== "synchronize") {
    return new Response(JSON.stringify({ message: `Action ${action} ignored.` }), { status: 200 });
  }

  console.log(`Processing PR #${prNumber} for ${repository}`);

  try {
    // 1. Fetch PR Diff using GitHub API
    const diffResponse = await fetch(`https://api.github.com/repos/${repository}/pulls/${prNumber}`, {
      headers: {
        "Authorization": `token ${env.GITHUB_TOKEN}`,
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
        "Authorization": `token ${env.GITHUB_TOKEN}`,
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
