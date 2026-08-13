# Euclid

An agentic studio for 3Blue1Brown-style educational videos. The user's own
Claude connects over **MCP** and authors videos by calling tools; a **React +
PixiJS** frontend shows every change live on a canvas/timeline editor; a
**Cloudflare** backend owns the document, auth, credits, and the render
pipeline.

## The one invariant

**Rendering is a pure function of `(document, time)`.** No wall-clock, no
accumulated state. This is what makes the browser preview and the headless
export pixel-identical, scrubbing instant, and the event log replayable.
Everything else is built around it.

## Architecture

```
              MCP tools                      ops (HTTP/WS)
  Claude ───────────────► apps/mcp ──┐   ┌─────────────── apps/web (editor)
  (user's own tokens)                ▼   ▼
                            apps/api  ── ProjectDO (Durable Object)
                            Better Auth      · doc + version + event log
                            Stripe credits   · serializes every write
                            D1 / R2          · broadcasts to WebSockets
                                     │
                              render queue (TODO)
                                     ▼
                            apps/renderer (container)
                            Chromium replays render.html → ffmpeg → MP4
```

| Package | What it is |
|---|---|
| `packages/dsl` | **The contract.** Zod-typed scene document (scenes → nodes → keyframe tracks + transitions), the op vocabulary, and the shared reducer every writer uses. |
| `packages/engine` | Deterministic sampler (`resolveNode(node, t)` — pure, Worker-safe) + Pixi stage adapter behind `@euclid/engine/pixi`. |
| `apps/api` | Cloudflare Worker: Hono routes, Better Auth (D1), Stripe credit packs + webhook, `ProjectDO` per project, render job + credit debit. |
| `apps/mcp` | Cloudflare Worker (`McpAgent`): agent-facing verbs — `add_latex`, `animate`, `morph_latex`, `write_on`, `set_narration`, `render_video`… all compile to DSL ops. |
| `apps/web` | Vite/React editor: Pixi preview, timeline scrub, inspector edits (same op path as the agent). Also serves `render.html`, the headless export surface. |
| `apps/renderer` | Node + Playwright + ffmpeg container: replays the doc frame-by-frame through `render.html` and encodes MP4. Target: Cloudflare Containers fed by a Queue. |

### Concurrency model
Serialized ops + event log — no CRDT. Every writer submits an `OpEnvelope`
with a `baseVersion`; the `ProjectDO` applies it via the shared reducer,
bumps the version, appends to the log, and broadcasts. On 409 the writer
refetches and rebases (the MCP worker retries automatically).

### Credits
Agent iteration is **free** (users burn their own Claude tokens). Credits
meter server-side spend only: renders (per second × resolution) and TTS
minutes. See `packages/dsl/src/limits.ts`. Packs sold via Stripe checkout.

### Product ceilings (v1)
1080p max, 30/60 fps, 10 minutes per video. LaTeX + shapes/text/groups are
the v1 primitives; graphs/axes and code blocks come later.

## Development

```sh
pnpm install
pnpm dev:api        # api on :8787 (D1 + Durable Objects)
pnpm dev:mcp        # mcp on :8788 (service-binds to the api; start api first)
pnpm dev:web        # editor on :5173 (?project=<id> to connect; no param = offline demo)
pnpm typecheck      # all packages
scripts/tunnel.sh   # public tunnel to local api (Better Auth dashboard, webhooks)
```

Config lives in the root `.env` (committed defaults) + `.env.local`
(gitignored secrets/overrides). Full setup, env details, and the
verification tools: **[docs/dev-setup.md](docs/dev-setup.md)**.

## Docs & roadmap

Developer reference and phased plans (with task completion markers) live in
**[docs/](docs/README.md)**. Current status: [docs/plans/000-roadmap.md](docs/plans/000-roadmap.md).
