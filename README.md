# automation-hub

Cloudflare Worker-based automation services for the Lornu AI ecosystem.

## Workers

This repository hosts multiple Cloudflare Workers for automation and orchestration:

1. **automation-hub** (Main): CI automation service
   - Production: https://dash.cloudflare.com/1d361f061ebf3d1a293900bdb815db26/workers/services/view/automation-hub/production
   - Related Issue: https://github.com/lornu-ai/private-lornu-ai/issues/542

2. **lornu-edge-discovery** (Edge Discovery): High-speed agent discovery service
   - Location: `src/edge-discovery/`
   - Uses Cloudflare Hyperdrive for Azure PostgreSQL acceleration
   - Related Issue: https://github.com/lornu-ai/private-lornu-ai/issues/589
   - See [src/edge-discovery/README.md](src/edge-discovery/README.md) for details

## Setup

This repo is scaffolded for Cloudflare Workers using wrangler. Each worker has its own `wrangler.toml` configuration file.

## Usage

Automates CI workflows using Cloudflare Workers. Extend `src/worker.ts` for custom logic.

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