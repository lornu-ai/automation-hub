
# Copilot Instructions for automation-hub

## Project Overview
automation-hub is a Cloudflare Worker-based platform for:
- **CI automation** (delegates all logic to Python for auditability and flexibility)
- **OIDC identity provider** (sovereign, multi-cloud, short-lived JWTs)

### Architecture (Text Diagram)

```
┌────────────┐      ┌──────────────┐      ┌──────────────┐
│  GitHub    │      │ Cloudflare   │      │ Python CI    │
│  Actions   │──▶──▶│ Worker (TS)  │──▶──▶│ Logic        │
└────────────┘      │ src/worker.ts│      │ci_automation.py│
                    └──────────────┘      └──────────────┘
                           │
                           ▼
                    ┌──────────────┐
                    │ OIDC Hub     │
                    │ src/oidc-hub.ts │
                    └──────────────┘
```

## Key Files & Structure
- **src/worker.ts**: Cloudflare Worker entrypoint for CI. Delegates all logic to Python (`ci_automation.py`).
- **ci_automation.py**: Extend `run_ci_task(event: dict)` for all CI workflows. No logic in TypeScript.
- **src/oidc-hub.ts**: OIDC provider. Implements `/mint`, discovery, and JWKS endpoints.
- **azure-eks-dev-deploy.md**: Azure EKS build/deploy guide (see for real-world workflow).
- **wrangler.toml**, **wrangler-oidc-hub.toml**: Worker deployment configs.
- **dockworker.toml**: Container build config (Dockworker is required for traceability).

## Developer Workflows
- **TypeScript build**: `bun install && bun run build`
- **Local preview**: `wrangler dev`
- **Container build**: `dockworker build -c dockworker.toml`
- **Push to Azure ACR**:
  - `az acr login --name <acr>`
  - `docker tag ...`
  - `docker push ...`
- **Deploy to EKS**: Update manifests, then `kubectl apply -k <overlay>`
- **Run Python CI locally**: `uv run python ci_automation.py '{"trigger": "manual", "branch": "main"}'`

## Patterns & Conventions
- **All CI logic is Python**: Never add business logic to TypeScript. Only delegate to `ci_automation.py`.
- **No image builds from forks**: All builds must originate from the main repo for compliance/audit.
- **Kustomize overlays**: Used for all Kubernetes deployments.
- **Secrets**: Set via `wrangler secret put ... --config wrangler-oidc-hub.toml`.
- **Dockworker**: Required for container builds (ensures traceability).
- **OIDC endpoints**: `/mint`, `/.well-known/openid-configuration`, `/.well-known/jwks.json`.

## Integration Points
- **Worker → Python**: In production, use API/service binding to invoke Python logic from Worker (see comments in `src/worker.ts`).
- **OIDC Hub**: Integrates with Azure/AWS/GCP for federated identity. See `src/oidc-hub.ts` for endpoint details.

## External Dependencies
- Cloudflare Workers (Wrangler)
- Bun (TypeScript build)
- Dockworker (container build)
- Azure CLI, kubectl, Docker
- Python (uv for dependency management)

## Example: OIDC Token Minting
POST `/mint` with Bearer API key and JSON body:
```json
{
  "subject": "user@example.com",
  "audience": "client-id",
  "claims": {"roles": ["user"]}
}
```

## Troubleshooting & FAQ
- **CI logic not running?** Ensure all logic is in `ci_automation.py` and not TypeScript.
- **OIDC token errors?** Check secrets are set and request body matches required fields.
- **Build fails on fork?** Only main repo builds are allowed for compliance.
- **Container not traceable?** Use Dockworker, not plain Docker.

---

**For unclear or missing sections, please provide feedback so instructions can be improved.**
