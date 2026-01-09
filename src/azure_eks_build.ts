// azure_eks_build.ts
// Script to automate building and pushing the automation-hub container image to Azure Container Registry (ACR) for EKS
// Usage: bun run azure_eks_build <acrName> <imageTag>

import { $ } from "bun";

const [,, acrName, imageTag = "dev"] = process.argv;

if (!acrName) {
  console.error("Usage: bun run azure_eks_build <acrName> <imageTag>");
  process.exit(1);
}

async function main() {
  // 1. Build the image using Dockworker
  await $`dockworker build -c dockworker.toml`;

  // 2. Tag the image for ACR
  const fullTag = `${acrName}.azurecr.io/automation-hub:${imageTag}`;
  await $`docker tag automation-hub:dev ${fullTag}`;

  // 3. Login to ACR
  await $`az acr login --name ${acrName}`;

  // 4. Push the image
  await $`docker push ${fullTag}`;

  console.log(`Image pushed: ${fullTag}`);
}

main().catch(err => {
  console.error("Build or push failed:", err);
  process.exit(1);
});
