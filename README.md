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
pnpm dev:web        # editor on :5173 (offline demo works with no backend)
pnpm dev:api        # api on :8787 (needs .dev.vars — see apps/api/.dev.vars.example)
pnpm dev:mcp        # mcp on :8788 (service-binds to the api)
pnpm typecheck      # all packages

# smoke-test the doc→ops→sample pipeline
pnpm --filter @euclid/renderer exec tsx src/smoke.ts

# screenshot timeline moments through the real export surface (vite must be running)
pnpm --filter @euclid/renderer exec tsx src/shot.ts 1.0 7.0

# render the demo/an actual project to mp4 (vite + api running; needs ffmpeg)
pnpm --filter @euclid/renderer render -- --project <id> --out out.mp4
```

First-time backend setup: `wrangler d1 create euclid` (put the id in
`apps/api/wrangler.jsonc`), apply `apps/api/schema.sql`, generate Better Auth
tables with `npx @better-auth/cli generate`.

## Status / roadmap

Done: DSL + reducer, sampler, Pixi stage (write-on, keyframe tracks, latex
crossfade-morph — all verified frame-accurate), MCP tool layer, ProjectDO
sync, editor with live preview/timeline/inspector, credit + Stripe scaffold,
renderer script.

Next, in order:
1. **v1 milestone**: agent builds a 60s narrated equation-morph video E2E.
2. MCP OAuth (workers-oauth-provider backed by Better Auth) so claude.ai connects.
3. TTS adapter (word-timestamp provider first) + audio mux in the renderer.
4. Render queue → Cloudflare Containers; upload MP4 to R2; job status updates.
5. Dashboard UI: project list, credits page, auth screens.
6. Matched-glyph LaTeX morphing (upgrade inside the existing texMorph seam).
