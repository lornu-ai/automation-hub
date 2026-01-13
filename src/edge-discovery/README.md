# Cloudflare Edge Discovery Worker (Hyperdrive)

High-speed agent discovery service using Cloudflare Hyperdrive to accelerate Azure PostgreSQL queries.

## Overview

This Cloudflare Worker provides **sub-100ms agent discovery** by:
1. **Caching** agent registry data in Cloudflare D1 (edge cache)
2. **Accelerating** Azure PostgreSQL queries via Hyperdrive connection pooling
3. **Reducing latency** from ~300ms to <50ms per discovery request

## Architecture

```
GKE Dock Workers → Cloudflare Edge Discovery → Hyperdrive → Azure PostgreSQL
                                      ↓
                                 D1 Cache (60s TTL)
```

- **Azure PostgreSQL**: Source of truth (durable registry)
- **Cloudflare Hyperdrive**: Connection pooling accelerator (~300ms savings)
- **Cloudflare D1**: Edge cache (60-second hot cache for instant responses)

## Prerequisites

1. **Azure PostgreSQL Flexible Server** with:
   - Database: `registry`
   - Table: `dock_workers` (with columns: name, version, endpoint, capabilities, reliability_score, status, last_heartbeat, cloud_provider, region)
   - Network access: Cloudflare IP ranges or Cloudflare Tunnel

2. **Cloudflare Account** with:
   - Workers plan (Free tier works for development)
   - Hyperdrive enabled (requires Workers Paid plan for production)
   - D1 database (optional, for edge caching)

## Setup

### Step 1: Create Hyperdrive Configuration

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create Hyperdrive config for Azure PostgreSQL
cd src/edge-discovery
npx wrangler hyperdrive create azure-registry-link \
  --connection-string="postgresql://lornu_admin:${DB_PASSWORD}@lornu-prod-db.postgres.database.azure.com:5432/registry"

# Note: Replace ${DB_PASSWORD} with your actual password, or use:
# export DB_PASSWORD="your-secure-password"
# npx wrangler hyperdrive create ... --connection-string="postgresql://...${DB_PASSWORD}..."
```

**Output**: You'll receive a Hyperdrive ID (e.g., `abc123def456...`)

### Step 2: Create D1 Database (Optional)

```bash
# Create D1 database for edge caching
npx wrangler d1 create lornu-discovery-cache

# Initialize schema (using INTEGER for efficient timestamp comparisons)
npx wrangler d1 execute lornu-discovery-cache --command="
  CREATE TABLE IF NOT EXISTS agent_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
"
```

**Output**: You'll receive a D1 Database ID (e.g., `xyz789abc123...`)

### Step 3: Update wrangler.toml

Edit `src/edge-discovery/wrangler.toml` and replace placeholders:

```toml
[[hyperdrive]]
binding = "AZURE_REGISTRY"
id = "YOUR_HYPERDRIVE_ID_HERE"  # ← Paste from Step 1

[[d1_databases]]
binding = "EDGE_CACHE"
database_name = "lornu-discovery-cache"
database_id = "YOUR_D1_ID_HERE"  # ← Paste from Step 2
```

### Step 4: Configure Azure Network Security

**Option A: Cloudflare IP Ranges** (Simpler, but database exposed to public internet)

1. Navigate to Azure Portal → PostgreSQL Flexible Server → Networking
2. Add firewall rule for Cloudflare IP ranges:
   - https://www.cloudflare.com/ips/
   - Add IPv4 ranges (or use Cloudflare Tunnel for better security)

**Option B: Cloudflare Tunnel** (Recommended for production)

1. Install `cloudflared` on a machine with access to Azure PostgreSQL
2. Create tunnel:
   ```bash
   cloudflared tunnel create lornu-postgres
   cloudflared tunnel route dns lornu-postgres postgres.lornu.ai
   ```
3. Configure tunnel to forward to Azure PostgreSQL internal endpoint
4. Update Hyperdrive connection string to use `postgres.lornu.ai` instead of public IP

### Step 5: Deploy Worker

```bash
cd src/edge-discovery
npm install
npm run deploy
```

**Output**: Worker URL (e.g., `https://lornu-edge-discovery.your-subdomain.workers.dev`)

### Step 6: Configure DNS

Point `discovery.lornu.ai` to your Worker:

```bash
# Via Cloudflare Dashboard
# DNS → Add Record:
# - Type: CNAME
# - Name: discovery
# - Target: lornu-edge-discovery.your-subdomain.workers.dev
# - Proxy: ✅ (Orange cloud)
```

## API Endpoints

### GET /discover?skill=<skill_id>

Discover agents by capability.

**Example**:
```bash
curl "https://discovery.lornu.ai/discover?skill=sql_optimization"
```

**Response**:
```json
{
  "agents": [
    {
      "name": "DataSplicer-04",
      "version": "1.0.0",
      "endpoint": "https://datasplicer-04.lornu.ai",
      "capabilities": [
        {
          "id": "sql_optimization",
          "description": "SQL query optimization"
        }
      ],
      "reliability_score": 0.95,
      "status": "ONLINE",
      "last_heartbeat": "2026-01-09T12:00:00Z",
      "cloud_provider": "gcp",
      "region": "us-central1"
    }
  ],
  "source": "edge_cache",  // or "azure_registry"
  "count": 1
}
```

### GET /healthz

Health check endpoint.

**Response**:
```json
{
  "status": "ok",
  "service": "lornu-edge-discovery",
  "region": "eastus2",
  "hyperdrive_configured": true,
  "d1_configured": true
}
```

## Development

```bash
cd src/edge-discovery
npm install

# Local development with wrangler dev
npm run dev

# View logs
npm run tail

# Deploy to production
npm run deploy
```

## Performance

- **Edge Cache Hit**: <10ms (D1 cache)
- **Azure Query (via Hyperdrive)**: <50ms (vs ~300ms without Hyperdrive)
- **Cache TTL**: 60 seconds (configurable via `DISCOVERY_CACHE_TTL`)

## Troubleshooting

### Hyperdrive Connection Errors

```bash
# Test Hyperdrive connection
npx wrangler hyperdrive list

# Verify connection string format
# Should be: postgresql://user:pass@host:port/database
```

### D1 Cache Issues

```bash
# Check D1 database
npx wrangler d1 list

# Query cache manually
npx wrangler d1 execute lornu-discovery-cache --command="SELECT * FROM agent_cache LIMIT 5"
```

### Azure Network Access

```bash
# Test Azure PostgreSQL connectivity from Cloudflare
# Use Cloudflare Tunnel if direct connection fails
```

## Related Issues

- **Issue #589**: Cloudflare Hyperdrive for Azure PostgreSQL (this implementation)
- **Issue #588**: Cloudflare Edge Discovery Layer (multi-cloud sync)
- **Issue #583**: Agent Registry Service (FastA2A pattern)

## References

- [Cloudflare Hyperdrive Docs](https://developers.cloudflare.com/hyperdrive/)
- [Cloudflare D1 Docs](https://developers.cloudflare.com/d1/)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
