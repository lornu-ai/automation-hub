# Azure EKS Development Build & Deploy Guide

This guide describes how to build and push development builds of the automation-hub Cloudflare Worker for testing on Azure (EKS).

## Prerequisites
- Bun installed (`bun --version`)
- Wrangler CLI installed (`npm install -g wrangler` or `bun add wrangler`)
- Azure CLI installed and authenticated
- kubectl configured for your EKS cluster
- Docker or Podman installed (for container builds)

## 1. Build the Worker (TypeScript → JS)
```bash
bun install
bun run build
```

## 2. (Optional) Test Locally
You can use wrangler to preview the Worker:
```bash
wrangler dev
```

## 3. Build Container Image for EKS
Use Dockworker (preferred) or Docker directly. Example Dockworker config is recommended for Lornu AI projects.

### Using Dockworker
Ensure you have a `dockworker.toml` in the repo root. Then:
```bash
dockworker build -c dockworker.toml
```

### Using Docker (if needed)
```bash
docker build -t automation-hub:dev .
```

## 4. Push Image to Azure Container Registry (ACR)
```bash
az acr login --name <your-acr-name>
docker tag automation-hub:dev <your-acr-name>.azurecr.io/automation-hub:dev
docker push <your-acr-name>.azurecr.io/automation-hub:dev
```

## 5. Deploy to EKS
Update your Kubernetes manifests (Deployment, Service, Ingress) to use the new image tag, then apply:
```bash
kubectl apply -k <your-kustomize-overlay>
```

## 6. Verify Deployment
```bash
kubectl get pods -n <namespace>
kubectl logs <pod-name> -n <namespace>
```

---

- For production, follow the same steps but use a production tag and overlay.
- For Lornu AI, always use Dockworker and Kustomize overlays for GitOps compliance.
