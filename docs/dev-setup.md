# Local development

## Environment

One root **`.env`** (committed — safe defaults only) plus **`.env.local`**
(gitignored — machine overrides and real secrets like `BETTER_AUTH_API_KEY`).
Precedence: real shell env > `.env.local` > `.env`.

Three consumers, three delivery paths:

| Consumer | How it gets env |
|---|---|
| Wrangler workers (api, mcp) | `scripts/sync-env.mjs` generates `apps/*/.dev.vars` (runs automatically in `pnpm dev:api` / `dev:mcp`; wrangler hot-reloads the file) |
| Vite (web) | reads `VITE_*` from the root natively (`envDir` in vite.config.ts) |
| Renderer scripts | `src/load-env.ts` imported at the top of each script |

Never edit `.dev.vars` by hand — they're generated. Production secrets are
set with `wrangler secret put <NAME>` per worker (same `BETTER_AUTH_API_KEY`
value is used in prod and dev, per Better Auth cloud setup).

## First-time setup

```sh
pnpm install
cd apps/api
pnpm exec wrangler d1 execute euclid --local --file=./schema.sql       # app tables
pnpm exec wrangler d1 execute euclid --local --file=./auth-schema.sql  # better auth tables
```

## Daily loop

```sh
pnpm dev:api    # :8787 — API + Durable Objects + D1; also starts the public tunnel
pnpm dev:mcp    # :8788 — MCP worker (service-binds to api; start api first)
pnpm dev:web    # :5173 — editor; ?project=<id> connects, no param = offline demo
```

`dev:api` prints the tunnel URL before wrangler takes over the console (also
recorded as `TUNNEL_ORIGIN` in `.env.local`). It changes on every restart —
re-paste it wherever an external service points at your dev backend.

`DEV_ALLOW_ANON=1` (default in `.env`) makes sessionless requests act as
`dev-user`, so the editor syncs before auth UI exists.

## Public tunnel

Started automatically by `pnpm dev:api`; run standalone with `pnpm tunnel`
(→ prints `https://<random>.trycloudflare.com` → :8787).

Use it whenever something on the internet must reach local dev: the Better
Auth cloud dashboard (Base URL = tunnel URL, base path `/api/auth`), Stripe
webhooks, claude.ai MCP later. The script writes `TUNNEL_ORIGIN` to
`.env.local` so the worker trusts the origin. Quick tunnels get a **new URL
every run** — re-run and re-paste after restarting.

## Verification tools (apps/renderer/src)

| Script | What it proves |
|---|---|
| `smoke.ts` | reducer + sampler math, no browser |
| `shot.ts <t...>` | pixel-accurate frames of the demo doc through the export surface |
| `check-app.ts` | editor loads with zero console/page errors |
| `check-live.ts <projectId>` | external op appears in the open editor via WebSocket |
| `render.ts --project <id>` | full MP4 export (needs ffmpeg) |

Run any of them with `pnpm --filter @euclid/renderer exec tsx src/<script>`.
Visual changes should be verified with screenshots (Read the PNGs), not by
reading code.
