# MCP tool surface

The agent-facing API. Since [plans/008](plans/008-mcp-gateway.md) it is a
**gateway**: `apps/mcp/src/index.ts` exposes five fixed tools and holds no
capability logic. Everything an agent can *do* lives in the API worker's
capability catalog (`apps/api/src/agent/`), and this page describes the
gateway — the capability list itself is served by `instructions`, which is
the copy that cannot go stale.

## The five tools

| Tool | Semantics |
|---|---|
| `instructions` | Orientation, the workflow, cost rules, and every capability with a one-line summary. **Read once per new thread.** Free |
| `describe` | Full arguments and behaviour for named capabilities (batched). Free. Call it when a summary isn't enough, or when `execute` rejects your arguments |
| `execute` | Run one **free** capability: `{name, args}`. Every edit, read, narration script, caption and asset operation goes through here |
| `execute_paid` | Run one **credit-spending** capability — today `generate_narration` and `render_video`. Separate on purpose (see below) |
| `ask_user` | Put a choice to the human **in chat** and stop. Free, and blocking by intention. Stays a tool of its own (see below) |

## Why this shape

- **The tool list never changes.** An MCP client caches `tools/list` when the
  session starts, so a surface naming each capability needed a client restart
  every time one changed — that cost two milestone runs their tool coverage.
  Here the catalog is read at call time: an edit is live on the next call in
  the same session (measured end-to-end, ~14s, same session id, no reconnect).
- **Paid work is a separate door.** MCP permissions are per-tool. With one
  executor, "always allow" would quietly cover renders. A paid capability
  refuses `execute` and names `execute_paid`; a free one refuses
  `execute_paid`, so the split can't be worked around by always using the
  paid door.
- **`ask_user` cannot be a capability.** Asking is a protocol act — the server
  asks the *client* to open its own picker (elicitation) — and the fallback
  controls what the agent puts in its very next reply. Neither survives being
  flattened into request/response. Closing a question is ordinary state, so
  `record_answer` *is* a capability: `execute(name="record_answer")`.
- **Bytes stay on REST.** Tool args are JSON; base64 through an LLM context is
  a non-starter, so asset upload is a plain endpoint (`POST
  /api/projects/:id/assets`, internal-key only).

One capability returns an **image**: `preview_frames` hands back a contact
sheet as an MCP image block beside its caption — the only way an agent can see
what it is making. It is free, and refuses `execute_paid` so it stays that way.
The gateway carries this generically: any capability may set `image`, and the
plain-text response form says an image was omitted rather than dropping it
silently.

One capability is destructive: `delete_project` removes a project and
everything it owns, and nothing can bring it back. It requires `confirm: true`;
called without it, it reports what would be lost and deletes nothing — the same
shape as `remove_asset`'s `force`.

## Rules the catalog keeps

- Capabilities speak **intent** (`animate`, `morph_latex`); everything compiles
  to DSL ops applied through the shared reducer beside the Durable Object.
- Results are **compact text** — outlines, ids, time ranges — so agent
  iteration stays free. Only `generate_narration` and `render_video` cost
  credits; everything else is free to call as often as needed. (`?format=json`
  on the gateway returns the structured payload instead, which is what the
  editor binds to — same handler, two renderings.)
- Writes auto-rebase: fetch version → submit → retry ×3 on 409.
- Coordinates are canvas pixels, origin top-left. Times are scene-local
  seconds. Nodes anchor at their center. A scene may also have a **camera**
  (`set_camera` / `move_camera`) — node coordinates never change; the camera
  decides which part of the scene the frame shows, so a diagram can be laid
  out larger than the canvas. `get_project` prints it as `cam@(x,y) zoom=…`,
  because a framing that hides half the scene makes every coordinate in the
  outline misleading otherwise.
- Structured content is addressed by **what it is, not where it is**: `tex`
  names a sub-expression of an equation, `cells` names a row, column, cell or
  band of a `matrix`/`tokens` node (`{"rows":1}`, `{"rows":[0,1],"cols":2}`,
  0-based). An index the node does not have is an error, not a marker drawn
  somewhere plausible.
- Capabilities report what they *did*, not what they were asked to do. Several
  succeed in ways that change nothing on screen — a patch shadowed by a track,
  narration cut at a scene edge — and say so in the result rather than leaving
  it to be discovered in a render.
- **Unknown arguments are refused, not dropped.** The executor rejects any key
  a capability does not declare, naming it and listing what is accepted. Zod
  strips by default, which turned a typo into a success — `highlight(colour:)`
  used to reply "highlighting … (color)" while silently using the default.
  Enforced centrally, so no capability can opt out.
- **Errors are the documentation.** Validation is server-side now, so a
  rejection names the argument to fix, the capability to call next, or what
  *does* exist ("scene sc_1 not found. This project has: …"). Responses carry
  `catalog revision`, so a schema that moved mid-thread can say so instead of
  looking like a malformed call.

## Adding a capability

One catalog entry in `apps/api/src/agent/tools-*.ts` — name, summary, prose
contract, Zod args, optional `costsCredits`, handler — and it is listed,
describable and executable. No MCP worker change, no client restart, no row to
add here. `apps/api` is on **zod v4** (see dev-setup for why that is load
bearing).

Verified by `check-gateway.ts` (catalog over HTTP) and `check-mcp-tools.ts`
(the same surface over JSON-RPC, which is where client-side argument
stringification shows up).

Auth: currently `dev-user` via the internal service key. OAuth
(workers-oauth-provider backed by the API's Better Auth), so claude.ai
connects as a real user, is Phase 5 in [plans/000](plans/000-roadmap.md) —
deliberately last. Note what that client implies: it has no shell, so every
result here is its only feedback. That is the argument
[plans/007](plans/007-agent-sight.md) is built on, and the gateway does not
change it.
