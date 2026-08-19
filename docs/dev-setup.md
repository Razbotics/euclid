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

> **Adding a key takes two edits.** `sync-env.mjs` copies an explicit
> allowlist, so a key added to `.env` alone never reaches `.dev.vars` — add it
> to the `targets` list in the script too. And wrangler does **not** reliably
> hot-reload secrets, so restart the worker afterwards; a `501 … is not
> configured` from a capability whose key you just added is this, not the key.
> `FAL_KEY` is optional: without it the `generate_*` capabilities say so
> plainly instead of failing obscurely.

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

> **The assets probe columns** were added this way on 2026-08-19:
>
> ```sh
> pnpm exec wrangler d1 execute euclid --local \
>   --command "ALTER TABLE assets ADD COLUMN width INTEGER"
> ```
>
> ...and the same for `height INTEGER`, `fps REAL`, `probed_at INTEGER`.

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
                #        editor: explorer | canvas | scene; ⌘B / ⌘⌥B collapse the
                #        sides, drag the seams to resize (double-click to reset)

# The render backend: drains the render queue AND serves preview_frames on
# :8790. Without it, render_video jobs stay `queued` forever with the credits
# already spent, and preview_frames 503s. Needs dev:web (it drives render.html)
# + ffmpeg.
pnpm --filter @euclid/renderer exec tsx src/render-worker.ts

```

### Running the renderer in its container

The export image is `apps/renderer/Dockerfile`. Build from the **repo root**,
because the build context has to include `packages`:

```sh
docker build -f apps/renderer/Dockerfile -t euclid-renderer:bench .
```

```sh
docker run --rm -e RENDER_PAGE_URL=http://<your-lan-ip>:5173/render.html \
  -e FRAMES=60 -v "$PWD/apps/renderer/src:/app/apps/renderer/src:ro" \
  euclid-renderer:bench pnpm exec tsx src/bench-capture.ts
```

Three things bite, in order:

> **The image tag must match the playwright version in the lockfile.** The
> image ships the browser builds that version expects. The Dockerfile said
> `v1.49.1-jammy` while the repo had moved to 1.62.1.

> **`host.docker.internal` reaches the host but Vite refuses it.** Vite blocks
> requests whose `Host` header it does not recognise, so the page loads and
> `window.__euclid` is simply never defined — which looks like a renderer bug
> rather than a network one. Use the LAN address Vite prints as `Network:`,
> and start it with `--host` or nothing outside the machine can reach it at all.

> **On Apple Silicon the container is arm64**, not the x86_64 Cloudflare
> Containers run. Absolute timings do not transfer; ratios do. Building
> `--platform linux/amd64` runs under emulation and measures qemu.

> **`CAPTURE=png`** forces the export back onto screenshots. The default is
> WebCodecs, which is ~2.3x faster and is chosen by asking the page whether
> `VideoEncoder` exists — a secure-context API, so a render page served over
> plain http silently has none and the fallback engages by itself. Set it when
> you want to compare the two, or to rule the encoder out of a rendering bug.

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
| `smoke-mux.ts` | audio placement + ffmpeg args: narration offsets and trims, music/effect tracks (gain, fades, cut at the end of the video), mute removing a lane from the mix but not from the timeline, clips dragged between lanes, and the silent path staying filter-free (free) |
| `shot.ts <t...>` | pixel-accurate frames of the demo doc through the export surface |
| `shot-project.ts <projectId> <t...>` | the same, for a **real project** at global seconds — how every milestone run has actually found its visual bugs (`OUT_DIR=` to choose where; needs `dev:api` + `dev:web`). Superseded once `preview_frames` lands (plans/007) |
| `check-mcp-tools.ts` | MCP surface driven as a real client does: `animate` arg coercion, tool registration (free; needs `dev:api` + `dev:mcp`) |
| `preview.ts <projectId> [t...]` | contact sheet of a real project at its key moments (`FULL=<i>` also writes that frame full-res; free, needs `dev:api` + `dev:web`) — the developer half of the agent's `preview_frames` |
| `check-render-queue.ts` | a submitted job reaches `done` unattended with a downloadable MP4, two workers cannot claim the same job, and a failing render reaches `failed` **and refunds** (**spends ~4 credits**; needs `dev:api` + `dev:web`) |
| `check-preview.ts` | agent sight end to end: key moments → sheet → drill-down, delivered as base64 through the gateway, plus the blank-capture guards (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-axes.ts` | axes and ticks: a frame draws with round-number ticks, a curve plotted with `axesId` passes through the point its own axes call (2,4) — proved by framing the camera on that tick at 20x, where it reads 6.1% against 0.0% two units off — an axis moves to the rectangle's edge when zero is out of range, and the frame draws itself on (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-flows.ts` | flows (plans/006 Phase D): an arrow recomputed as its anchor moves (proved by framing the camera on the corridor the arrow must stretch across — an arrow baked at creation leaves it empty), curved pairs that separate, a token travelling a path by arc length, and the dangling/self-link/wrong-type/track-shadowing messages (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-mesh.ts` | mesh solids (plans/009). Starts with a **pure winding invariant** — for a convex solid centred on the origin every face must satisfy `n · centroid > 0` — which is the only thing that catches an inside-out solid, since an inverted one has an identical silhouette and identical ink (milestone run 7 shipped a cylinder wound inward on all 64 faces). Then in pixels: a background-coloured sphere in front of a bright disc takes it from 13.7% lit to **0.00%** (so the solid really is solid), flat shading reads 15.8% against 18.0% unshaded (so shading is per face), culled and unculled agree to 0.00% (the visible consequence of the sort being right), a cube framed at 8x reads 100% on it and 0% beside it, a pitch orbit moves a torus 12.8%→22.9%, and `write_on` builds it face by face (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-fal.ts` | generative assets (plans/009) end to end: a real flux-schnell image arrives, is checked to its **magic bytes**, and is filed at the path asked for; credits debit exactly once; a rejected 3D request fails and **refunds in full**; polling twice moves neither balance nor file count (**spends a few tenths of a US cent**; needs `dev:api` with `FAL_KEY`, no renderer) |
| `bench-capture.ts` | where export time actually goes: times `renderFrame` (Pixi/WebGL) against `canvas.screenshot()` (PNG round-trip) separately, on a vector document and a 4,096-triangle mesh. Answers plans/003's SwiftShader question — screenshot is **97-99%** of a frame in both the host and the container, so rasterisation is not the bottleneck (free; needs `dev:web`) |
| `check-narration-sync.ts` | narration-anchored animation: word matching ignores case and punctuation, an anchored highlight lands on its word, and — the point — **rewriting the script moves the effect with it** (the word went 1.26s → 6.14s and the marker followed: 0.41% lit at the old time vs 4.87% at the new). Also the refusal when neither `start` nor `atWord` is given (**~3 credits**; needs `dev:api` with `ELEVENLABS_API_KEY`, `dev:web`, `render-worker.ts`) |
| `check-video.ts` | the video node: the source-time mapping is pure, a clip draws only inside its range (and nothing after — it leaves rather than freezing), the overrun warning names the scene end, and — the headline — **two independent renders of one document are bit-identical** (PSNR inf), which is the purity invariant tested where it is hardest. Free: the clip under test is made with ffmpeg rather than generated (needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-image.ts` | the image node: a generated still draws at contain/cover/fill, the outline names the box and the fit, a drawn image resists deletion, and generate_image points at add_image. The assertion that matters is preview/export agreement — each process preloads the bytes separately, because the page has no session (**spends 2 credits**; needs `dev:api` with `FAL_KEY`, `dev:web`, `render-worker.ts`) |
| `check-glb.ts` | GLB import (plans/009): an inside-out fixture (a trusted cube with every face reversed) is detected by **signed volume** and repaired, a real trellis model imports at 10,132 → 1,382 triangles and draws, culled and unculled agree to 0.00% (the assertion that catches a bad Y-up→Y-down flip, since a hollow shell has the same silhouette), and the non-GLB, wrong-asset-kind and document-budget errors all teach (**spends ~17 credits**; needs `dev:api` with `FAL_KEY`, `dev:web`, `render-worker.ts`) |
| `check-fal-roster.ts` | every fal roster model end to end, verifying the one thing submitting cannot: each entry's `output()` reader, which only runs on a *successful* result. Bytes are sniffed by magic number rather than trusted from the mime. Takes model names as arguments, or all of them (**spends real money, ~$0.50 for the full roster**, most of it `kling-video`; needs `dev:api` with `FAL_KEY`). Run when the roster changes, not per commit — a wrong reader is the one bug here that loses money quietly, since fal has already charged for the inference we then refund |
| `check-3d.ts` | pseudo-3D (plans/006 Phase C) in pixels: depth decides draw order (the same two discs read 6.1% lit one way round and 0.0% with only their depths swapped), nearer draws 2.8x larger, an arrow orbited end-on foreshortens to a dot, a lattice stays lit through a 120° orbit, a cloud reveals dot by dot, and a spatial node with no camera still draws flat (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-matrix.ts` | structured primitives (plans/006 Phase B) in pixels: a matrix renders and fills in cell by cell, a box lands on the row it addressed (proved by framing the camera on that row — ink cannot see *where*), spotlight dims the rest, a cell morph gains columns, tokens and group children stagger, and range/type/shape errors all teach (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
| `check-camera.ts` | the scene camera (plans/006 Phase A) measured in pixels: zoom magnifies by z², panning leaves the subject behind, a node laid out past the canvas edge becomes visible, an animated push-in grows frame by frame, a roll clips a bar to 0.6× — plus camera key moments and the shadowing/range/reset errors (free; needs `dev:api`, `dev:web`, `render-worker.ts`) |
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
