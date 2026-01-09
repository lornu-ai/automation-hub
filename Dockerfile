# Dockerfile for automation-hub (Cloudflare Worker)
FROM oven/bun:1.0 AS build
WORKDIR /app
COPY . .
RUN bun install && bun run build

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY wrangler.toml ./
COPY package.json ./
COPY ci_automation.py ./
COPY pyproject.toml ./
COPY requirements.txt ./

# (Optional) Install Python dependencies with uv
RUN pip install uv && uv sync

CMD ["node", "dist/worker.js"]
