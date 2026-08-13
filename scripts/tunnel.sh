#!/usr/bin/env bash
# Cloudflare quick tunnel to the local API worker, for anything that must
# reach dev from the public internet (Better Auth cloud dashboard, Stripe
# webhooks, claude.ai MCP once OAuth lands).
#
#   scripts/tunnel.sh [port]   (default 8787)
#
# Writes TUNNEL_ORIGIN into .env.local and re-syncs .dev.vars so the API
# worker trusts the tunnel origin. Quick tunnels get a fresh URL every run —
# re-run this script, then update the URL wherever you pasted it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8787}"
LOG=/tmp/euclid-tunnel.log

pkill -f 'cloudflared tunnel --url' 2>/dev/null || true
sleep 1
nohup cloudflared tunnel --url "http://localhost:$PORT" > "$LOG" 2>&1 &

URL=""
for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
if [ -z "$URL" ]; then
  echo "tunnel failed to start — see $LOG" >&2
  exit 1
fi

touch "$ROOT/.env.local"
grep -v '^TUNNEL_ORIGIN=' "$ROOT/.env.local" > "$ROOT/.env.local.tmp" || true
echo "TUNNEL_ORIGIN=$URL" >> "$ROOT/.env.local.tmp"
mv "$ROOT/.env.local.tmp" "$ROOT/.env.local"
node "$ROOT/scripts/sync-env.mjs" > /dev/null

echo "$URL"
