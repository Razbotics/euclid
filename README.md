# Euclid

An agentic video studio. The user's own Claude connects over **MCP** and
authors videos by calling tools; a **React + PixiJS** frontend shows every
change live on a canvas/timeline editor; a **Cloudflare** backend owns the
document, auth, credits, and the render pipeline.

Explanatory/math animation (3Blue1Brown-style) is the **first vertical**, not
the boundary — the roadmap extends to general video editing and reels,
including ingesting source footage and having the agent generate segments
from it. See [plans/003-general-video.md](docs/plans/003-general-video.md).

Everything rests on one invariant: **rendering is a pure function of
`(document, time)`** — which is what makes the live preview and the final
export pixel-identical. See [docs/architecture.md](docs/architecture.md) for
that and the other load-bearing decisions.

## Component map

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

## Quickstart

```sh
pnpm install
pnpm dev:api    # :8787 — API + Durable Objects + D1, and the public tunnel
pnpm dev:mcp    # :8788 — MCP worker (start the api first)
pnpm dev:web    # :5173 — editor (?project=<id> to connect; no param = offline demo)
```

First-time database setup, the `.env` / `.env.local` system, and the
verification scripts: **[docs/dev-setup.md](docs/dev-setup.md)**.

## Docs

| | |
|---|---|
| [docs/](docs/README.md) | index; how docs and plans are maintained |
| [architecture.md](docs/architecture.md) | document model, sync, render path, credits — and why |
| [dev-setup.md](docs/dev-setup.md) | environment, commands, gotchas, verification tools |
| [mcp-tools.md](docs/mcp-tools.md) | the agent-facing tool surface |
| [plans/000-roadmap.md](docs/plans/000-roadmap.md) | current status and what's next |

Contributing conventions (including the rule that docs ship with the code):
[CLAUDE.md](CLAUDE.md).
