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

> **Mostly historical:** an MCP client captures the tool list **when the
> session starts**, so adding or changing a tool used to need a restart of the
> *client* (a fresh `claude` session), not just the worker. Sessions that
> missed a change would read the docs, fail to call it, and fall back to raw
> JSON-RPC — which looks like the tool working while bypassing the client
> entirely. This cost two milestone runs their tool-surface coverage, and is
> the main reason the gateway exists.
>
> Since [plans/008](plans/008-mcp-gateway.md) the tool list is five fixed
> entries and capabilities are read from the API worker at call time, so
> **editing a capability needs no restart of anything** — verified end-to-end
> at ~14s: same MCP session id, unchanged tool list, new capability text. The
> old rule still applies to the five gateway tools themselves, which is
> exactly why they are meant to stop changing.

> **Gotcha:** `apps/api` must declare **zod v4**, while `packages/dsl` and
> `apps/mcp` stay on v3. `better-call` (under Better Auth) takes zod as a
> *peer*, so it resolves to whatever the importing app declares — adding a
> plain `zod: ^3` to `apps/api` flips it onto v3 and the worker dies at boot
> with `zod_default.url is not a function`. `pnpm.overrides` cannot fix it
> (overrides retarget dependency versions, not peer resolution). Inside
> `apps/api` use the v4 API: `z.record(z.string(), z.any())`, and never
> compose a `@euclid/dsl` Zod object into a v4 schema.
>
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

> **Gotcha:** that idempotence covers new *tables*, not new *columns*.
> `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a column
> added to `schema.sql` never reaches a database that already has the table.
> Run the `ALTER` once by hand, e.g. for the assets `path` column:
>
> ```sh
> pnpm exec wrangler d1 execute euclid --local \
>   --command "ALTER TABLE assets ADD COLUMN path TEXT"
> ```
>
> Code should tolerate the column being NULL until then — the assets API falls
> back to `defaultAssetPath()` rather than showing a broken tree.

## Daily loop

```sh
pnpm dev:api    # :8787 — API + Durable Objects + D1; also starts the public tunnel
pnpm dev:mcp    # :8788 — MCP worker (service-binds to api; start api first)
pnpm dev:web    # :5173 — `/` lists projects; ?project=<id> opens one; ?demo=1 = offline demo

# The render backend: drains the render queue AND serves preview_frames on
# :8790. Without it, render_video jobs stay `queued` forever with the credits
# already spent, and preview_frames 503s. Needs dev:web (it drives render.html)
# + ffmpeg.
pnpm --filter @euclid/renderer exec tsx src/render-worker.ts

```

### Renders do not start themselves in dev

`render_video` debits credits and creates a **`queued`** job, then returns
"poll `get_render_status` for the download URL". In production a render worker
picks the job up. **In dev nothing does** — the Queues/Containers work is
still deferred ([plans/002](plans/002-render-pipeline.md)) — so the job stays
`queued` forever and the poll never resolves. Drive it by hand:

```sh
pnpm --filter @euclid/renderer exec tsx src/render.ts \
  --project <projectId> --job <jobId>
```

It marks the job `rendering`, uploads to R2 and marks it `done`; a crash marks
it `failed`, which refunds the credits automatically. Needs `dev:web` (it
drives `render.html`). Without `--job` it ignores the job lifecycle and just
writes a local MP4 via `--out`.

This bit milestone run 4: the agent polled a `queued` job repeatedly with no
indication that the queue had no consumer. If you are adding a dev-loop
checklist anywhere, this belongs on it.

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

> **Run the render worker, or nothing renders.** `render_video` creates a
> `queued` job; `render-worker.ts` is what claims and runs it. Without it a job
> sits in `queued` forever with the credits already debited — the failure that
> cost milestone run 5 ten minutes. `get_render_status` now reports each job's
> age and says so when one has been queued for minutes.
>
> To render a single job by hand instead (debugging, or a job the worker
> failed):
>
> ```sh
> pnpm --filter @euclid/renderer exec tsx src/render.ts --project <id> --job <jobId>
> ```
>
> Note the `exec tsx` form. `pnpm --filter … render -- --project` forwards the
> `--` and node's `parseArgs` rejects it as an unexpected positional — the
> command that used to be written in the code comment did not work.
> `get_render_status` now shows each job's age and says so when one has been
> queued for minutes.

## Verification tools (apps/renderer/src)

| Script | What it proves |
|---|---|
| `smoke.ts` | reducer + sampler math, no browser |
| `smoke-captions.ts` | cue generation at both fidelities, SRT/VTT formatting |
| `smoke-tts.ts [--live]` | TTS alignment → word timings (free; `--live` makes one real call) |
| `smoke-texmorph.ts` | glyph matching + morph interpolation, on real MathJax coordinates (free) |
| `smoke-assets.ts` | asset paths (traversal-safe), virtual folder tree, and which assets the document references (free, no browser) |
| `smoke-mux.ts` | narration placement + ffmpeg args: offsets, trims, silent path (free) |
| `shot.ts <t...>` | pixel-accurate frames of the demo doc through the export surface |
| `shot-project.ts <projectId> <t...>` | the same, for a **real project** at global seconds — how every milestone run has actually found its visual bugs (`OUT_DIR=` to choose where; needs `dev:api` + `dev:web`). Superseded once `preview_frames` lands (plans/007) |
| `check-mcp-tools.ts` | MCP surface driven as a real client does: `animate` arg coercion, tool registration (free; needs `dev:api` + `dev:mcp`) |
| `preview.ts <projectId> [t...]` | contact sheet of a real project at its key moments (`FULL=<i>` also writes that frame full-res; free, needs `dev:api` + `dev:web`) — the developer half of the agent's `preview_frames` |
| `check-render-queue.ts` | a submitted job reaches `done` unattended with a downloadable MP4, two workers cannot claim the same job, and a failing render reaches `failed` **and refunds** (**spends ~4 credits**; needs `dev:api` + `dev:web`) |
| `check-preview.ts` | agent sight end to end: key moments → sheet → drill-down, delivered as base64 through the gateway, plus the blank-capture guards (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-gateway.ts` | agent gateway (plans/008): instructions → describe → execute, and **every capability in the catalog** — transitions and overlap-replace, the credit gate, both `update_node` traps, arg coercion, asset in-use refusal (free; needs `dev:api` only) |
| `check-decisions.ts` | agent → human → agent question loop, driven headless as a shell-less client would (free; needs `dev:api` + `dev:mcp`) |
| `check-delete.ts` | project deletion: confirm guard, side-effect-free dry run, tenancy, and that the cascade clears D1 rows, R2 bytes **and** the Durable Object's document (free; needs `dev:api`) |
| `check-assets.ts` | asset upload → download is byte-identical; tenancy enforced; the explorer routes the editor binds to — list, move (incl. traversal refusal), delete (needs `dev:api`) |
| `check-narration.ts [--refund]` | TTS generation end-to-end: pricing, debit, op reaches the doc, overflow warning (**spends credits**; `--refund` needs a broken key, costs nothing) |
| `check-app.ts` | project list renders and opens a project; demo editor loads; zero console/page errors |
| `check-narration-ui.ts` | editor narration preview: audio loads cross-origin, exact captions render, overrun panel fixes the scene (**spends credits**; needs `dev:api` + `dev:web`) |
| `check-live.ts <projectId>` | external op appears in the open editor via WebSocket |
| `render.ts --project <id>` | full MP4 export with narration audio (needs ffmpeg) |
| `check-mux.ts` | A/V sync in a real render, measured with `silencedetect` (**spends credits**; needs ffmpeg + `dev:api` + `dev:web`) |
| `bench-webcodecs.ts` | WebCodecs codec support + 1080p encode throughput in headless Chromium |

Scripts that create a project **delete it again when they pass**, so a green
run leaves the project list as it found it. A *failing* run deliberately keeps
its fixture, so the wreckage can be opened in the editor. Debris from passing
runs is what previously grew the list to 105 projects.

Run any of them with `pnpm --filter @euclid/renderer exec tsx src/<script>`.
Visual changes should be verified with screenshots (Read the PNGs), not by
reading code.
