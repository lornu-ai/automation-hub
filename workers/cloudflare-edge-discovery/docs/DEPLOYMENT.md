# Cloudflare Edge Discovery Worker - Deployment Guide

## Prerequisites

1. **Cloudflare Account** with:
   - Workers plan (Free tier for dev, Paid for production)
   - Hyperdrive enabled (requires Workers Paid plan)
   - D1 database (optional, for edge caching)

2. **Azure PostgreSQL Flexible Server** with:
   - Database: `registry`
   - Table: `dock_workers` (see schema below)
   - Network access configured (see Network Security section)

3. **Wrangler CLI** installed:
   ```bash
   npm install -g wrangler
   ```

## Database Schema

The `dock_workers` table should have the following structure:

```sql
CREATE TABLE IF NOT EXISTS dock_workers (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]',
  reliability_score FLOAT DEFAULT 0.0,
  status TEXT NOT NULL DEFAULT 'OFFLINE',
  last_heartbeat TIMESTAMP,
  cloud_provider TEXT,
  region TEXT
);

CREATE INDEX IF NOT EXISTS idx_dock_workers_status ON dock_workers(status);
CREATE INDEX IF NOT EXISTS idx_dock_workers_capabilities ON dock_workers USING GIN(capabilities);
```

## Deployment Steps

### Step 1: Install Dependencies

```bash
cd apps/cloudflare-edge-discovery
npm install
```

### Step 2: Login to Cloudflare

```bash
wrangler login
```

### Step 3: Create Hyperdrive Configuration

```bash
# Create Hyperdrive config for Azure PostgreSQL
npx wrangler hyperdrive create azure-registry-link \
  --connection-string="postgresql://lornu_admin:password@lornu-prod-db.postgres.database.azure.com:5432/registry"
```

**Output**: Copy the Hyperdrive ID (e.g., `abc123def456...`)

### Step 4: Create D1 Database (Optional, for Edge Caching)

```bash
# Create D1 database
npx wrangler d1 create lornu-discovery-cache

# Initialize schema
npx wrangler d1 execute lornu-discovery-cache --command="
  CREATE TABLE IF NOT EXISTS agent_cache (
    cache_key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
"
```

**Output**: Copy the D1 Database ID (e.g., `xyz789abc123...`)

### Step 5: Update wrangler.toml

Edit `wrangler.toml` and replace placeholders:

```toml
[[hyperdrive]]
binding = "AZURE_REGISTRY"
id = "YOUR_HYPERDRIVE_ID_HERE"  # ← Paste from Step 3

[[d1_databases]]
binding = "EDGE_CACHE"
database_name = "lornu-discovery-cache"
database_id = "YOUR_D1_ID_HERE"  # ← Paste from Step 4
```

### Step 6: Configure Azure Network Security

**Option A: Cloudflare IP Ranges** (Simpler, but database exposed)

1. Get Cloudflare IP ranges: https://www.cloudflare.com/ips/
2. Navigate to Azure Portal → PostgreSQL Flexible Server → Networking
3. Add firewall rules for Cloudflare IPv4 ranges

**Option B: Cloudflare Tunnel** (Recommended for production)

1. Install `cloudflared`:
   ```bash
   brew install cloudflared  # macOS
   # or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/
   ```

2. Create tunnel:
   ```bash
   cloudflared tunnel create lornu-postgres
   cloudflared tunnel route dns lornu-postgres postgres.lornu.ai
   ```

3. Configure tunnel config file (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: lornu-postgres
   credentials-file: /path/to/credentials.json
   
   ingress:
     - hostname: postgres.lornu.ai
       service: postgresql://lornu-prod-db.postgres.database.azure.com:5432
   ```

4. Start tunnel:
   ```bash
   cloudflared tunnel run lornu-postgres
   ```

5. Update Hyperdrive connection string to use `postgres.lornu.ai` instead of public IP

### Step 7: Deploy Worker

```bash
# Deploy to Cloudflare
npm run deploy
```

**Output**: Worker URL (e.g., `https://lornu-edge-discovery.your-subdomain.workers.dev`)

### Step 8: Configure DNS

Point `discovery.lornu.ai` to your Worker:

**Via Cloudflare Dashboard**:
1. Navigate to DNS → Add Record
2. Configure:
   - **Type**: CNAME
   - **Name**: discovery
   - **Target**: `lornu-edge-discovery.your-subdomain.workers.dev`
   - **Proxy**: ✅ (Orange cloud enabled)

**Via Wrangler CLI** (if using Cloudflare DNS):
```bash
wrangler dns create discovery.lornu.ai CNAME lornu-edge-discovery.your-subdomain.workers.dev
```

### Step 9: Verify Deployment

```bash
# Health check
curl https://discovery.lornu.ai/healthz

# Discovery test
curl "https://discovery.lornu.ai/discover?skill=sql_optimization"

# Run smoke test
./scripts/smoke-test.sh
```

## Environment Variables

Configure via `wrangler.toml` `[vars]` section:

```toml
[vars]
AZURE_REGION = "eastus2"
DISCOVERY_CACHE_TTL = "60"  # Cache TTL in seconds
```

## Monitoring

### View Logs

```bash
# Real-time logs
npm run tail

# Or via Wrangler
wrangler tail
```

### Metrics

Monitor via Cloudflare Dashboard:
- **Workers** → `lornu-edge-discovery` → Metrics
- **Hyperdrive** → `azure-registry-link` → Metrics

Key metrics:
- Request count
- Error rate
- Latency (p50, p95, p99)
- Hyperdrive connection pool usage

## Troubleshooting

### Hyperdrive Connection Errors

```bash
# List Hyperdrive configs
npx wrangler hyperdrive list

# Test connection
npx wrangler hyperdrive get azure-registry-link

# Verify connection string format
# Should be: postgresql://user:pass@host:port/database
```

### D1 Cache Issues

```bash
# List D1 databases
npx wrangler d1 list

# Query cache manually
npx wrangler d1 execute lornu-discovery-cache --command="SELECT * FROM agent_cache LIMIT 5"

# Clear cache
npx wrangler d1 execute lornu-discovery-cache --command="DELETE FROM agent_cache"
```

### Azure Network Access

```bash
# Test Azure PostgreSQL connectivity
# Use Cloudflare Tunnel if direct connection fails
# Verify firewall rules allow Cloudflare IP ranges
```

### Worker Errors

```bash
# Check Worker logs
npm run tail

# Verify Worker is deployed
wrangler deployments list

# Rollback if needed
wrangler rollback
```

## Production Checklist

- [ ] Hyperdrive configured and tested
- [ ] D1 database created (if using edge cache)
- [ ] Azure network security configured (Tunnel or IP ranges)
- [ ] DNS configured (`discovery.lornu.ai` → Worker)
- [ ] Health check endpoint responding
- [ ] Discovery endpoint returning agents
- [ ] Latency <100ms verified
- [ ] Monitoring configured
- [ ] Smoke test passing

## Related Documentation

- [README.md](../README.md) - Overview and API documentation
- [Issue #589](https://github.com/lornu-ai/private-lornu-ai/issues/589) - Implementation tracking
- [Issue #588](https://github.com/lornu-ai/private-lornu-ai/issues/588) - Edge Discovery Layer
