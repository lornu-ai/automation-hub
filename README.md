# automation-hub

Cloudflare Worker-based CI automation service.

## Workers

### automation-hub (CI Automation)
- Production Worker: https://dash.cloudflare.com/1d361f061ebf3d1a293900bdb815db26/workers/services/view/automation-hub/production
- Related Issue: https://github.com/lornu-ai/private-lornu-ai/issues/542
- Configuration: `wrangler.toml`

### oidc-hub (OIDC Identity Provider)
- Endpoint: `oidc-hub.dockworker.ai`
- Related Issue: https://github.com/lornu-ai/dockworker.ai/issues/24
- Configuration: `wrangler-oidc-hub.toml`

The OIDC hub provides:
1. **OIDC Discovery** endpoint (`/.well-known/openid-configuration`)
2. **JWKS** endpoint (`/.well-known/jwks.json`) for public key distribution
3. **Token Minting** endpoint (`/mint`) for issuing short-lived JWT tokens

## Setup

This repo is scaffolded for Cloudflare Workers using wrangler. See `wrangler.toml` and `wrangler-oidc-hub.toml` for deployment configs.

## Usage

### CI Automation Worker

Automates CI workflows using Cloudflare Workers. Extend `src/worker.ts` for custom logic.

### OIDC Hub Worker

Sovereign OIDC identity provider for multi-cloud authentication (Azure/AWS/GCP).

**Deployment:**
```bash
# Set required secrets
wrangler secret put PRIVATE_KEY --config wrangler-oidc-hub.toml
wrangler secret put ISSUER_URL --config wrangler-oidc-hub.toml
wrangler secret put ALLOWED_AUDIENCE --config wrangler-oidc-hub.toml  # Optional

# Deploy
wrangler deploy --config wrangler-oidc-hub.toml
```

**Generate Private Key:**
```bash
openssl genrsa -out private.pem 2048
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in private.pem -out private-pkcs8.pem
wrangler secret put PRIVATE_KEY --config wrangler-oidc-hub.toml < private-pkcs8.pem
```

### Build (with Bun)

To build TypeScript sources before deployment:

```bash
bun install


### Azure EKS Development Build & Deploy

- All builds and images originate from the private-lornu-ai repo for compliance and traceability.
- Use Dockworker for building and Kustomize overlays for deployment.
- For detailed steps, see [azure-eks-dev-deploy.md](azure-eks-dev-deploy.md).

#### Automated Build & Push Script

To build and push the container image to Azure Container Registry (ACR) for EKS, use the Bun script:

```bash
bun run azure:build <acrName> <imageTag>
# Example:
bun run azure:build myacr dev
```

This will:
- Build the image with Dockworker
- Tag it for your ACR
- Login to ACR
- Push the image

You can then update your Kubernetes manifests to use the new image tag.
- Use Dockworker for building and Kustomize overlays for deployment.
- Do not build or push images from forks or other sources.

This ensures all automation-hub deployments are fully auditable and compliant with Lornu AI standards.
## Python CI Automation

All automation logic should be implemented in Python using uv for dependency management.

- Main Python script: ci_automation.py
- Extend run_ci_task(event: dict) for custom CI logic
- Cloudflare Worker delegates CI events to Python automation (see src/worker.ts)

### Example: Run Python CI Task Locally

```bash
uv run python ci_automation.py '{"trigger": "manual", "branch": "main"}'
```

### Integration

In production, use an API or service binding to invoke Python logic from the Worker.