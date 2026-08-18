# Export worker image — target: Cloudflare Containers (or any container host).
# Playwright base ships Chromium + all system deps.
# The tag MUST match the playwright package version in the lockfile: the image
# ships the browser builds that version expects, and a mismatch fails at launch.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

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
