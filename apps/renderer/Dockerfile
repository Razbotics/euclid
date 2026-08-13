# Export worker image — target: Cloudflare Containers (or any container host).
# Playwright base ships Chromium + all system deps.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Workspace install (build context must be the repo root):
#   docker build -f apps/renderer/Dockerfile .
COPY pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/renderer ./apps/renderer
RUN pnpm install --filter @euclid/renderer... --prod=false

WORKDIR /app/apps/renderer
# TODO(queue): replace one-shot CMD with a Cloudflare Queues consumer loop
CMD ["pnpm", "render"]
