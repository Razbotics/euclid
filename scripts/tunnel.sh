#!/usr/bin/env bash
# Cloudflare quick tunnel to the local API worker, for anything that must
# reach dev from the public internet (Better Auth cloud dashboard, Stripe
# webhooks, claude.ai MCP once OAuth lands).
#
#   scripts/tunnel.sh [port]           reuse the running tunnel if healthy
#   scripts/tunnel.sh --force [port]   force a new tunnel (new URL)
#
# Reuse is the default on purpose: quick tunnels get a random URL every run,
# and that URL is pasted into external dashboards by hand. Restarting the
# backend should not invalidate it.
#
# Writes TUNNEL_ORIGIN into .env.local and re-syncs .dev.vars so the API
# worker trusts the tunnel origin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0
if [ "${1:-}" = "--force" ]; then
  FORCE=1
  shift
fi
PORT="${1:-8787}"
LOG=/tmp/euclid-tunnel.log

# Reuse: a live cloudflared process plus a TUNNEL_ORIGIN that still answers.
if [ "$FORCE" -eq 0 ] && pgrep -f 'cloudflared tunnel --url' > /dev/null 2>&1; then
  EXISTING=$(grep '^TUNNEL_ORIGIN=' "$ROOT/.env.local" 2>/dev/null | cut -d= -f2- || true)
  if [ -n "$EXISTING" ] && curl -s -o /dev/null --max-time 8 "$EXISTING/api/auth/ok"; then
    echo "$EXISTING (reused)"
    exit 0
  fi
fi

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

echo "$URL (new — re-paste it in any external dashboard)"
