/**
 * Cloudflare Edge Discovery Worker
 * 
 * Provides sub-100ms agent discovery by caching Azure PostgreSQL registry at the edge.
 * Uses Cloudflare Hyperdrive for high-speed connection pooling to Azure.
 * 
 * Architecture:
 * - Azure PostgreSQL: Source of truth (durable registry)
 * - Cloudflare Hyperdrive: Connection pooling accelerator (~300ms savings per request)
 * - Cloudflare D1: Edge cache (60-second hot cache for instant responses)
 * 
 * Endpoints:
 * - GET /discover?skill=<skill_id>: Discover agents by capability
 * - GET /register: Health check endpoint
 * - GET /healthz: Worker health check
 * 
 * See Issue #589 for implementation details.
 */

import { Client } from 'pg';

interface Env {
  AZURE_REGISTRY: {
    connectionString: string;
  };
  EDGE_CACHE?: D1Database;
  AZURE_REGION: string;
  DISCOVERY_CACHE_TTL: string;
}

interface AgentCard {
  name: string;
  version: string;
  endpoint: string;
  capabilities: Array<{
    id: string;
    description: string;
  }>;
  reliability_score: number;
  status: string;
  last_heartbeat: string;
  cloud_provider: string;
  region: string;
}

/**
 * Query Azure PostgreSQL via Hyperdrive for agent discovery
 */
async function queryAzureRegistry(
  env: Env,
  skill?: string
): Promise<AgentCard[]> {
  const client = new Client({
    connectionString: env.AZURE_REGISTRY.connectionString,
  });

  try {
    await client.connect();

    let query: string;
    let params: any[];

    if (skill) {
      // Query agents with specific skill
      query = `
        SELECT 
          name, version, endpoint, capabilities, reliability_score, 
          status, last_heartbeat, cloud_provider, region
        FROM dock_workers
        WHERE status = 'ONLINE'
          AND capabilities @> $1::jsonb
        ORDER BY reliability_score DESC
        LIMIT 10
      `;
      params = [JSON.stringify([{ id: skill }])];
    } else {
      // Query all active agents
      query = `
        SELECT 
          name, version, endpoint, capabilities, reliability_score,
          status, last_heartbeat, cloud_provider, region
        FROM dock_workers
        WHERE status = 'ONLINE'
        ORDER BY reliability_score DESC
        LIMIT 50
      `;
      params = [];
    }

    const result = await client.query(query, params);
    return result.rows.map((row) => ({
      name: row.name,
      version: row.version,
      endpoint: row.endpoint,
      capabilities: row.capabilities || [],
      reliability_score: row.reliability_score || 0.0,
      status: row.status,
      last_heartbeat: row.last_heartbeat,
      cloud_provider: row.cloud_provider || 'unknown',
      region: row.region || env.AZURE_REGION,
    }));
  } finally {
    await client.end();
  }
}

/**
 * Check D1 edge cache for recent agent data
 */
async function getCachedAgents(
  env: Env,
  skill?: string
): Promise<AgentCard[] | null> {
  if (!env.EDGE_CACHE) {
    return null; // D1 not configured
  }

  try {
    const cacheKey = skill ? `agents:${skill}` : 'agents:all';
    const cacheTTL = parseInt(env.DISCOVERY_CACHE_TTL || '60', 10);

    // Query D1 for cached agents (within TTL)
    const result = await env.EDGE_CACHE.prepare(
      `SELECT data, updated_at FROM agent_cache 
       WHERE cache_key = ? AND updated_at > datetime('now', '-' || ? || ' seconds')`
    ).bind(cacheKey, cacheTTL).first();

    if (result && result.data) {
      return JSON.parse(result.data as string);
    }
  } catch (error) {
    console.error('D1 cache read error:', error);
  }

  return null;
}

/**
 * Update D1 edge cache with fresh agent data
 */
async function updateCache(
  env: Env,
  agents: AgentCard[],
  skill?: string
): Promise<void> {
  if (!env.EDGE_CACHE) {
    return; // D1 not configured
  }

  try {
    const cacheKey = skill ? `agents:${skill}` : 'agents:all';
    const data = JSON.stringify(agents);

    // Upsert cache entry
    await env.EDGE_CACHE.prepare(
      `INSERT INTO agent_cache (cache_key, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(cache_key) DO UPDATE SET
         data = excluded.data,
         updated_at = datetime('now')`
    ).bind(cacheKey, data).run();
  } catch (error) {
    console.error('D1 cache write error:', error);
  }
}

/**
 * Main request handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check endpoint
    if (url.pathname === '/healthz') {
      return new Response(
        JSON.stringify({
          status: 'ok',
          service: 'lornu-edge-discovery',
          region: env.AZURE_REGION,
          hyperdrive_configured: !!env.AZURE_REGISTRY?.connectionString,
          d1_configured: !!env.EDGE_CACHE,
        }),
        {
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // Discovery endpoint
    if (url.pathname === '/discover') {
      const skill = url.searchParams.get('skill') || undefined;

      try {
        // 1. Check edge cache first (D1) for instant response
        const cachedAgents = await getCachedAgents(env, skill);
        if (cachedAgents && cachedAgents.length > 0) {
          return new Response(
            JSON.stringify({
              agents: cachedAgents,
              source: 'edge_cache',
              count: cachedAgents.length,
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=5',
              },
            }
          );
        }

        // 2. Cache miss: Query Azure via Hyperdrive
        const agents = await queryAzureRegistry(env, skill);

        // 3. Update edge cache in background (non-blocking)
        updateCache(env, agents, skill).catch((err) =>
          console.error('Background cache update failed:', err)
        );

        return new Response(
          JSON.stringify({
            agents,
            source: 'azure_registry',
            count: agents.length,
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'public, max-age=5',
            },
          }
        );
      } catch (error) {
        console.error('Discovery error:', error);
        return new Response(
          JSON.stringify({
            error: 'Registry timeout',
            message: error instanceof Error ? error.message : 'Unknown error',
          }),
          {
            status: 504,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // Registration endpoint (for future use - agents can register via this endpoint)
    if (url.pathname === '/register' && request.method === 'POST') {
      // TODO: Implement agent registration endpoint
      // This would write to Azure PostgreSQL via Hyperdrive
      return new Response(
        JSON.stringify({
          message: 'Registration endpoint not yet implemented',
          note: 'Agents should register directly to Azure PostgreSQL',
        }),
        {
          status: 501,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }

    // 404 for unknown endpoints
    return new Response(
      JSON.stringify({
        error: 'Not found',
        available_endpoints: ['/discover', '/healthz', '/register'],
      }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  },
};
