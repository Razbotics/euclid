# 001 — Local E2E (status: done)

Goal: every architectural seam exercised on a laptop before building
features on top. Completed 2026-08-14.

## Phase 1: Backend up
- [x] Local D1 with app schema + hand-written Better Auth core tables (auth-schema.sql)
- [x] `DEV_ALLOW_ANON` dev bypass so the editor works pre-auth-UI
- [x] API worker boots; projects CRUD against real D1

## Phase 2: Document path
- [x] Create project → ProjectDO init
- [x] Ops envelope applies (version 0 → 1) with scene + latex node
- [x] Stale baseVersion → 409; invalid op → 400 (schema layer) — both rejected
- [x] Doc round-trips intact

## Phase 3: Agentic loop
- [x] MCP worker boots, service-binds to api across wrangler dev processes
- [x] Streamable-HTTP handshake (initialize → session id → initialized)
- [x] `tools/list` returns all 16 tools
- [x] `add_latex` creates node; `animate` samples current value and writes track
- [x] `get_project` outline reflects all changes

## Phase 4: Live editor
- [x] Editor loads real project (no offline fallback)
- [x] External op (agent-style) arrives over WebSocket, UI updates without reload
- [x] MCP-created equation typeset on canvas; write-on state correct at t=0

## Phase 5: Env + tunnel
- [x] Root `.env` / `.env.local` with sync to .dev.vars, Vite envDir, renderer loader
- [x] `scripts/tunnel.sh` — quick tunnel with TUNNEL_ORIGIN trust wiring
- [x] Better Auth cloud dashboard reaches local auth through the tunnel (`/api/auth/ok` 200)

## Notes / gotchas discovered
- Pixi v8 `Application.destroy()` before `init()` resolves crashes — cleanup
  must chain off the init promise (StrictMode surfaces this).
- Pixi v8 masks: mask the wrapper container (`view.mask`), not a leaf child,
  or bounds warnings + invisible content.
- zsh doesn't word-split unquoted vars — use arrays for curl header sets.
- `mcp-session-id` must be grepped as `^mcp-session-id:` (CORS headers also
  contain the substring).
- Better Auth cloud dashboard needs the `dash()` plugin from
  `@better-auth/infra`; it verifies a JWT from the dash API and compares
  `hash(apiKey)` to the token's `apiKeyHash`. Failure modes are logged as
  `[Dash] …` — "hash mismatch" means wrong/stale key, "JWT missing" means an
  unauthenticated probe.
- wrangler does not hot-reload `.dev.vars`; a stale worker served the old
  API key and looked exactly like a bad integration. Restart after secret
  changes (sync-env now warns).
