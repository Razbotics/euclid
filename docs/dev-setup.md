# Local development

## Environment

| File | Contents | Committed? |
|---|---|---|
| `.env` | **Production values — real keys.** The base layer. | **No** — gitignored |
| `.env.local` | Only what must differ on this machine (localhost origins, dev flags, local auth secret). | **No** — gitignored |
| `.env.example` | Template of every supported key, placeholders only. | Yes |

Precedence: real shell env > `.env.local` > `.env`. So a laptop inherits
every real key from `.env` and overrides just the handful that are
environment-specific. New machine: `cp .env.example .env`, fill it in, then
add local overrides in `.env.local`.

**Never commit `.env` or `.env.local`.** Production deploys read `.env` and
push each value with `wrangler secret put <NAME>`.

Three consumers, three delivery paths:

| Consumer | How it gets env |
|---|---|
| Wrangler workers (api, mcp) | `scripts/sync-env.mjs` generates `apps/*/.dev.vars` (runs automatically in `pnpm dev:api` / `dev:mcp`; wrangler hot-reloads the file) |
| Vite (web) | reads `VITE_*` from the root natively (`envDir` in vite.config.ts) |
| Renderer scripts | `src/load-env.ts` imported at the top of each script |

Never edit `.dev.vars` by hand — they're generated. Production secrets are
set with `wrangler secret put <NAME>` per worker (same `BETTER_AUTH_API_KEY`
value is used in prod and dev, per Better Auth cloud setup).

> **Gotcha:** the MCP worker reaches the API through a wrangler service
> binding, and that discovery breaks if the API restarts on its own — calls
> then fail with `Worker "euclid-api" not found`. Restart **both**, API
> first: `pkill -f wrangler; pkill -f workerd`, start api, wait, start
> mcp. (`cloudflared` is a separate process, so the tunnel URL survives.)
>
> Use `pkill -f wrangler`, **not** `pkill -f "wrangler dev"` — the actual
> process is `node .../wrangler.js dev --port 8787`, so the quoted form
> matches nothing and silently leaves the old worker running. Two instances
> then fight over the port and the newer one dies during bundling.

> **Gotcha:** killing wrangler mid-build leaves a stale bundle behind, and
> the next start fails with `Could not resolve .../\.wrangler/tmp/bundle-XXXX/
> middleware-loader.entry.ts`. Fix by deleting `apps/*/.wrangler/tmp`. Never
> delete `.wrangler/state` — that is the local D1 database and R2 bucket.

> **Gotcha:** an MCP client captures the tool list **when the session starts**.
> Add or change a tool and existing sessions never see it — they can read the
> docs, fail to call it, and fall back to driving the worker over raw JSON-RPC,
> which looks like the tool working while bypassing the client entirely. After
> changing `apps/mcp`, restart the *client* (a fresh `claude` session), not
> just the worker. This has now cost two milestone runs their tool-surface
> coverage.

> **Gotcha:** wrangler does **not** reliably hot-reload `.dev.vars`. After
> changing a secret, restart the worker or it keeps serving the old value —
> which looks exactly like a broken third-party integration. `sync-env`
> prints a warning when it rewrites values while a worker is running.

## First-time setup

```sh
pnpm install
cd apps/api
pnpm exec wrangler d1 execute euclid --local --file=./schema.sql       # app tables
pnpm exec wrangler d1 execute euclid --local --file=./auth-schema.sql  # better auth tables
```

`schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-run it with
`pnpm --filter @euclid/api db:migrate:local` after pulling a schema change —
an existing local DB won't pick up a new table on its own.

## Daily loop

```sh
pnpm dev:api    # :8787 — API + Durable Objects + D1; also starts the public tunnel
pnpm dev:mcp    # :8788 — MCP worker (service-binds to api; start api first)
pnpm dev:web    # :5173 — `/` lists projects; ?project=<id> opens one; ?demo=1 = offline demo
```

`dev:api` prints the tunnel URL before wrangler takes over the console (also
recorded as `TUNNEL_ORIGIN` in `.env.local`). It changes on every restart —
re-paste it wherever an external service points at your dev backend.

`DEV_ALLOW_ANON=1` (default in `.env`) makes sessionless requests act as
`dev-user`, so the editor syncs before auth UI exists.

## Public tunnel

Started automatically by `pnpm dev:api`; run standalone with `pnpm tunnel`
(→ prints `https://<random>.trycloudflare.com` → :8787).

A healthy running tunnel is **reused**, so restarting the backend keeps the
same URL — quick-tunnel URLs are pasted into external dashboards by hand and
shouldn't churn. Force a fresh one with `scripts/tunnel.sh --force`.
To restart only the worker and keep the tunnel:
`pkill -f wrangler && (cd apps/api && pnpm dev)`.

Use it whenever something on the internet must reach local dev: the Better
Auth cloud dashboard (Base URL = tunnel URL, base path `/api/auth`), Stripe
webhooks, claude.ai MCP later. The script writes `TUNNEL_ORIGIN` to
`.env.local` so the worker trusts the origin. Quick tunnels get a **new URL
every run** — re-run and re-paste after restarting.

## Verification tools (apps/renderer/src)

| Script | What it proves |
|---|---|
| `smoke.ts` | reducer + sampler math, no browser |
| `smoke-captions.ts` | cue generation at both fidelities, SRT/VTT formatting |
| `smoke-tts.ts [--live]` | TTS alignment → word timings (free; `--live` makes one real call) |
| `smoke-texmorph.ts` | glyph matching + morph interpolation, on real MathJax coordinates (free) |
| `smoke-mux.ts` | narration placement + ffmpeg args: offsets, trims, silent path (free) |
| `shot.ts <t...>` | pixel-accurate frames of the demo doc through the export surface |
| `shot-project.ts <projectId> <t...>` | the same, for a **real project** at global seconds — how every milestone run has actually found its visual bugs (`OUT_DIR=` to choose where; needs `dev:api` + `dev:web`). Superseded once `preview_frames` lands (plans/007) |
| `check-mcp-tools.ts` | MCP surface driven as a real client does: `animate` arg coercion, tool registration (free; needs `dev:api` + `dev:mcp`) |
| `check-decisions.ts` | agent → human → agent question loop: asked over MCP, arrives live in the editor, answered by click (free; needs all three servers) |
| `check-assets.ts` | asset upload → download is byte-identical; tenancy enforced (needs `dev:api`) |
| `check-narration.ts [--refund]` | TTS generation end-to-end: pricing, debit, op reaches the doc, overflow warning (**spends credits**; `--refund` needs a broken key, costs nothing) |
| `check-app.ts` | project list renders and opens a project; demo editor loads; zero console/page errors |
| `check-narration-ui.ts` | editor narration preview: audio loads cross-origin, exact captions render, overrun panel fixes the scene (**spends credits**; needs `dev:api` + `dev:web`) |
| `check-live.ts <projectId>` | external op appears in the open editor via WebSocket |
| `render.ts --project <id>` | full MP4 export with narration audio (needs ffmpeg) |
| `check-mux.ts` | A/V sync in a real render, measured with `silencedetect` (**spends credits**; needs ffmpeg + `dev:api` + `dev:web`) |
| `bench-webcodecs.ts` | WebCodecs codec support + 1080p encode throughput in headless Chromium |

Run any of them with `pnpm --filter @euclid/renderer exec tsx src/<script>`.
Visual changes should be verified with screenshots (Read the PNGs), not by
reading code.
