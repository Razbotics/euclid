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
| `execute_paid` | Run one **credit-spending** capability — `generate_narration`, `render_video`, and the `generate_*` family. Separate on purpose (see below) |
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
  /api/projects/:id/assets`) rather than a tool. It takes two callers now:
  server-side producers with the internal key, and **the owning user**, since
  plans/003 chose "users bring their own media" and upload is therefore the
  whole ingest front door. The agent sees the result through `list_assets`,
  which reports what the background analysis has learned so far — dimensions
  and duration once probed, and `proxy 960x540` / `proxy pending` for a video
  the editor will scrub from a stand-in. **No capability was added for
  proxies**, deliberately: a proxy changes how a file behaves for a *person*
  scrubbing and nothing about what an agent builds or exports, so it is a
  property on the listing rather than a tool to call.

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
  iteration stays free. Only `generate_narration`, `render_video` and the
  `generate_*` family (image/video/audio/3d) cost
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
- Connections are **anchored, not positioned**: `connect` takes node ids — or
  one part of a grid, `{"node":"tok_x","cells":{"cols":2}}` — and the arrow
  recomputes its endpoints every frame, stopping at the edge of what it points
  at. `flow_along` rides a path by arc length and overrides the
  node's position from `start` onward — the one place a transition beats a
  track, which the response says out loud.
- A node can step **out of the world**: `pin_to_frame` makes it ignore the
  camera entirely, for captions and titles that should not swing about when
  the scene orbits.
- The third dimension is opt-in and inert until asked for: nodes take an
  optional `z` and `add_vector3`/`add_axes3d`/`add_points3`/`add_mesh` are
  spatial by
  type, but **nothing is projected until the camera has a `yaw` or `pitch`**
  (`orbit_camera` is the shorthand). Straight on, a cube is a square. Angles
  are radians everywhere except `orbit_camera`, whose argument is named
  `degrees` because an orbit is naturally "a quarter turn".
- Solids are **named, not typed out**: `add_mesh` takes `shape: "sphere"` plus
  a size, and the geometry is expanded from those numbers when drawing. A
  sphere is ~576 triangles; putting them in the document would push ~100KB
  through the event log on every op, and no agent can type them. The triangle
  ceiling (`LIMITS.maxTriangles`) is checked by arithmetic before anything is
  built. Two solids that physically intersect are the one case per-face
  sorting cannot draw correctly, and the tool says so rather than hiding it.
- Generation is **submit-then-collect**: `generate_image` / `generate_video` /
  `generate_audio` / `generate_3d` hand the request to fal, which holds it in
  its own queue. Fast models are waited for inline and return the asset;
  slower ones come back `pending` with a job id. **`get_generation_status` is
  what advances a job** — there is no background worker, so asking is
  collecting. Polling is idempotent and a failure refunds in full.
- **Every generated kind now reaches the stage**, by its own door: a still with
  `add_image`, a clip with `add_video`, a model with `import_mesh` (which
  decimates it to fit the document), and music onto a lane with
  `add_audio_clip`. Anything not placed is simply a file the project holds,
  visible to `list_assets`.
- An imported mesh is **simplified for storage, not for speed**. Geometry is
  kept in the document, the document lives under one Durable Object key, and DO
  values cap at 128 KiB — so `LIMITS.maxImportedTriangles` (2,000) sits well
  below the 4,000-triangle render ceiling, and `import_mesh` projects the
  resulting document size and refuses with a remedy rather than letting the
  write fail. It also re-winds the faces outward whichever way the file had
  them, because glTF is Y-up and this system is Y-down; a model that arrived
  inside out would otherwise draw as a hollow shell with the right outline.
- **Audio is a lane, not a node.** `add_audio_track` / `add_audio_clip` /
  `update_audio` place music and effects in *global* time, across cuts, because
  that is what a bed is; narration stays scene-scoped and is still managed by
  `set_narration` / `generate_narration`. A clip's length comes from the asset
  registry — a file stored without a duration cannot be measured server-side
  without decoding it, so the error asks for `durationSec` rather than guessing.
  `get_project` lists every lane and clip with the times they *actually* play,
  and marks a muted lane `MUTED (silent in the export)`: an unseen mute is a
  render that comes back missing a sound nobody remembers turning off.
- Timing can be **anchored to speech**: `write_on` and `highlight` take
  `atWord` instead of a `start`, and the anchor is stored rather than resolved
  away — so re-generating the narration re-syncs the effect instead of leaving
  it behind. `get_narration_timing` lists the words and when they are spoken.
  The written `start` remains as the fallback for a word that is not spoken, so
  an anchor can never break a render.
- Source footage is **selectable, not guessable**: `get_shots` reports where a
  video cuts and the segments between them, so `add_video`'s source range can
  land on a boundary. Detection runs in the background after upload and takes
  longer than measuring the file does, so "not watched yet" is a distinct
  answer from "no cuts found" — conflating them would read a pending analysis
  as a continuous take.
- A graph's **mapping is a node**: `add_axes` owns the rectangle, the ranges
  and the ticks, and `plot_function` takes its `axesId` to borrow them, so a
  curve cannot disagree with the frame it is read against.
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

### Adding a node type — the orientation block will make you describe it

The `instructions` block opens with hand-written prose, and that prose went
stale three times: it claimed "You cannot see the video" two lines above
`preview_frames` (run 6), it listed the spatial node types with no mention of
`mesh` (run 7), and it said "the two capabilities" cost credits long after
there were six. Each time the *generated* half — the capability list — was
correct and the sentence above it was not, because nothing connected them.

Three mechanisms now connect them, one per kind of claim:

| The claim | What holds it true |
|---|---|
| Which node types exist | `NODE_BLURBS` in `execute.ts` is a `Record<EuclidNode['type'], …>`. Adding a member to the union **fails the build** until it is described |
| How many capabilities cost credits | counted from the catalog, never typed |
| A capability named in prose | wrapped in `ref()`, which **throws at module load** if no such capability exists |

So adding a node type is: the DSL union, the schema, the renderer, and a
phrase in `NODE_BLURBS` — and the compiler names the last one for you. Node
types that read as one idea share a phrase (`rect`/`circle`/`line` → "shapes"),
so the paragraph stays prose rather than becoming an inventory.

Auth: currently `dev-user` via the internal service key. OAuth
(workers-oauth-provider backed by the API's Better Auth), so claude.ai
connects as a real user, is Phase 5 in [plans/000](plans/000-roadmap.md) —
deliberately last. Note what that client implies: it has no shell, so every
result here is its only feedback. That is the argument
[plans/007](plans/007-agent-sight.md) is built on, and the gateway does not
change it.
