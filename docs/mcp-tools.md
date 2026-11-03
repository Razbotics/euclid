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
  It also takes **`previewAt`** (plans/011 gap 5): global seconds that are
  captured as one contact sheet and returned **as an image block beside the
  question**, so a question about how something looks arrives with the picture
  rather than sending the human to find it. `request_review` puts *assets* in
  front of someone; what milestone run 8 needed eyes on was the composition,
  and the sheet reached the human only by being described in chat. Capture
  goes through `preview_frames` over the gateway, so its tile cap, labels and
  blank-frame detection all apply and the MCP worker stays a relay — and a
  capture that fails **refuses the whole call**, because asking about pixels
  without them is the failure this closes. The times are also stored as
  `refs.previewAt`, the one ref with **no consequence**: `planId` and
  `assetIds` change what answering *does*, this only changes what is being
  looked at while deciding. The editor renders them as a row of seek buttons,
  which is the thing an editor can offer that a contact sheet cannot — the
  live canvas at full size, scrubbable around each moment.
- **Bytes stay on REST.** Tool args are JSON; base64 through an LLM context is
  a non-starter, so asset upload is a plain endpoint (`POST
  /api/projects/:id/assets`) rather than a tool. It takes two callers now:
  server-side producers with the internal key, and **the owning user**, since
  plans/003 chose "users bring their own media" and upload is therefore the
  whole ingest front door. Those two differ only in *how much of what they say
  is believed* — the internal key never widens who a caller may write for, so
  the MCP worker, which forwards the real user's id beside the key, is confined
  to that user's own projects on this route exactly as it is everywhere else.
  The agent sees the result through `list_assets`, which reports what the
  background analysis has learned so far — dimensions and duration once probed,
  and `proxy 960x540` / `proxy pending` for a video the editor will scrub from
  a stand-in. **No capability was added for proxies**, deliberately: a proxy
  changes how a file behaves for a *person* scrubbing and nothing about what an
  agent builds or exports, so it is a property on the listing rather than a
  tool to call.

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
- **Projects are born in review mode** (plans/010): paid generation is gated
  behind a plan the human has approved. `propose_plan` submits scenes + an
  asset roster with a **server-priced** credit budget and returns a
  STOP-and-wait block; approval rides the ordinary decision path (an editor
  click, or `record_answer`), and each gated `generate_*` /
  `generate_narration` call must match the roster and fit the remaining
  budget — a failed generation refunds its budget alongside its credits. The
  gate refuses with the remedy (`propose_plan`, or a revision) rather than a
  status code; `get_plan` shows the budget, `set_review_mode` lifts the gate
  when the human says so. Free work is never gated.
- **Generated files land pending the human's approval.** `request_review`
  puts them in front of the human (one verdict per batch — group only what
  stands or falls together); placement (`add_image`, `add_video`,
  `import_mesh`, `add_audio_clip`) refuses anything unapproved, and
  `render_video` is the last net, refusing while the document references an
  unapproved asset. A rejection carries the human's note: regenerate with
  `revises` pointing at the rejected file so the versions stay linked
  (`list_assets` prints `[PENDING REVIEW]`, `[REJECTED: "note"]` and
  `rev of <id>`). Narration reviews the **script, not the takes** — the
  human's own words and re-synthesis of approved text auto-approve, and its
  audio is attached on generation so timings exist to choreograph against;
  the render net is what holds an unapproved take out of the export.
- **Assets belong to the user; projects hold links** (plans/010 phase 4).
  Anything generated or uploaded in any of the user's projects can be placed
  in any other — placing links it in automatically, `list_assets` with
  `scope: "library"` shows everything owned (marked with how many projects
  link each), and `link_asset` stages a file without placing it, under a
  per-project path. Links share the immutable file; nothing is copied.
  `unlink_asset` takes a file out of one project (refused while that
  document references it) without touching bytes; `remove_asset` deletes
  outright and refuses — with no force — while other projects link it.
  Deleting a project keeps any asset linked elsewhere, and says so.
- Results are **compact text** — outlines, ids, time ranges — so agent
  iteration stays free. Only `generate_narration`, `render_video` and the
  `generate_*` family (image/video/audio/3d) cost
  credits; everything else is free to call as often as needed. (`?format=json`
  on the gateway returns the structured payload instead, which is what the
  editor binds to — same handler, two renderings.)
- **The reads publish the shape of their `data`** (plans/013). `describe` used
  to document arguments and say nothing about what came back, which is the half
  a *program* needs before it can write the loop — and a program is what reads
  this once the agent composes calls in code rather than one per turn. A
  capability may declare an optional `result` Zod schema; `describe` prints it
  under `RESULT`, after the arguments, and `?format=json` carries it as JSON
  Schema. Declared on the seven reads a script computes over (`get_project`,
  `get_scene`, `get_history`, `get_plan`, `list_assets`,
  `get_narration_timing`, `get_shots`, `sample_at`) and **deliberately absent
  on the writes** — a write has nothing to compute over, and an empty contract
  is noise. It is a claim about a handler that assembles `data` by hand, so
  nothing in the type system holds the two together: `check-gateway.ts` calls
  each one for real and requires every field the contract calls required to
  actually be there. That mechanism found the defect that motivated it —
  `get_shots` promised `segments` and omitted it while detection was still
  pending, so a caller looping over it crashed on exactly the asset it was
  waiting for.
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
  track, which the response says out loud. It also says so when the scene both
  **projects and has something riding a path** (plans/011 gap 6, from run 8's
  off-orbit moon): a `path` is not projected point by point — the stage draws
  it at its anchor's projected position with that anchor's single perspective
  scale, while the follower is projected where it actually is. They agree while
  the camera is flat and part company as yaw grows (measured on a 500px orbit
  ring: 6px at yaw 0.05, 114px at yaw 0.9). The **follower** is the correct
  one and the drawn curve is the approximation, so the remedy is to hide the
  path — the motion left behind is right — rather than to flatten the camera
  and lose the orbit, which is what run 8 did. `flow_along`, `set_camera`,
  `move_camera` and `orbit_camera` all warn, because any of them can create the
  clash. The real fix is projecting path points per vertex, which is renderer
  work tracked in plans/010. It also takes a **speed profile**,
  `at: [{t, u}…]`, where `u` is a fraction of arc length (plans/011, from
  run 9): the path still supplies every coordinate and only the *pacing* is
  given, so an orbit that races at perihelion and dawdles at aphelion is one
  call rather than twenty-four hand-computed positions. `start`/`duration` are
  derived from the ends of the list and cannot be passed with it. Times must
  ascend; `u` need not, so a profile that rises and falls sends the node out
  and back. The response reports the **speeds it produced** (`133–1200 px/s`)
  rather than the profile back, because "does it vary the way I meant" is the
  only question this form raises.
- A node can step **out of the world**: `pin_to_frame` makes it ignore the
  camera entirely, for captions and titles that should not swing about when
  the scene orbits.
- **Draw order is document order, and `reorder_node` edits it** (plans/011
  gap 1). Ops only appended, so putting a backdrop behind what already exists
  meant deleting and rebuilding the scene — which also destroyed every
  transition bound to the removed ids. It takes one of `to: "back"/"front"`,
  `before`, `after` or `index`; `before`/`after` name a sibling and therefore
  decide the parent too, so "behind that thing" re-parents when it has to.
  Re-parenting is reported, because a child's coordinates are read relative to
  its group and the node really has moved on screen. In an orbited scene the
  stage sorts by **depth** and uses this order only to break ties, and the
  result says so; moving a spatial node into a group switches its projection
  off entirely, and warns.
- **One idea, one argument name — enforced, not just intended** (plans/011
  gap 3). Three separate milestone runs reached for `text` on `add_text` and
  `set_narration` and were wrong both times; the catalog was disagreeing with
  itself, and the agent's prior was the correct one. Both now take `text`, and
  `add_text` takes `color` like every other text-like node. A settled name's
  old spellings are listed in `BANNED_ARGS` and the catalog **throws at module
  load** if one reappears — the same shape as the duplicate-name check and
  `ref()`. `fill` is deliberately not in that list: on a shape it is half of a
  `fill`/`stroke` pair and means something `color` does not.
- **Two conventions, stated in the orientation block and checked against the
  schemas.** *Time is scene-local when the call names a scene, and global when
  it does not* — `preview_frames` and the audio lanes are the only three
  capabilities on the global side, and `check-gateway.ts` pins that list so a
  fourth cannot appear silently. *`x`/`y` are absolute canvas pixels and place
  the node; anything else geometric in the same call is measured from there* —
  a path's points, a line's `x2`/`y2`, a group's children. The one exception is
  `add_axes`/`plot_function`, whose x/y is the top-left of the plot rectangle.
- **A whole motion is one call** (plans/011, from run 9). `animate` takes
  either `to`/`start`/`duration` for one move or `keyframes: [{t, value}…]`
  for the whole track. The second form exists because run 9 spent **48 of its
  95 calls** building two non-uniform-speed motions a segment at a time:
  `flow_along` rides a path at constant speed and its easing is a single
  monotone curve, so "fast near the star, slow far from it, fast again" cannot
  be a flow — it has to be a track. Keyframes before the first `t` are kept, so
  the list composes with earlier calls exactly as `to` does; a late first
  keyframe warns, because a track holds its first value *backwards* in time.
  Ascending times, one shape for every value, and `LIMITS.maxKeyframesPerTrack`
  (500) as the ceiling — a mistyped entry among hundreds is what this form
  invites, and a bare number in a position track would sample as a number and
  put the node at (NaN, NaN) with nothing in the document looking wrong.
- **Undo exists, and it is not destructive** (plans/011 gap 4). `get_history`
  lists every version with its actor and op kinds; `revert_to_version` puts the
  document back to one of them. A revert is an ordinary op envelope
  (`doc.restore`), so the version goes **up**: history is append-only, a revert
  can be reverted, and every open editor applies it through the shared reducer
  off the same WebSocket — the editor contains no code that knows undo exists.
  A node comes back under its own id with its tracks and transitions attached,
  which is exactly what rebuilding by hand cannot do. It restores the
  *document*, not the world: assets, spent credits, render jobs and the review
  plan do not move. `delete_project` is the one thing it cannot undo — it
  destroys the log a revert replays.
- **Resolved state is readable without pixels**: `sample_at(sceneId, t)` runs
  the same `resolveScene` the renderer draws from and reports where every node
  *ends up* — world position with group transforms composed in, followers
  already on their paths, `screen=` once the camera has framed it, plus
  depth/perspective, write and highlight progress, and `INVISIBLE`/`OFF-FRAME`
  with the reason. It answers the questions that are numbers rather than
  pictures; `preview_frames` stays the answer for anything about extent, since
  this reports anchors and text is sized by the renderer.
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
- **Grounding is a model choice, not a flag** (2026-09-15). `generate_image`
  and `generate_video` take an `imageUrl`, but only the image-conditioned
  entries in the roster accept one — `flux-i2i`, `ltx-video-i2v`,
  `kling-video-i2v`. Handing an `imageUrl` to a text-to-image endpoint is
  **refused**, because fal would accept the call and ignore the field: the
  result is a good picture of the wrong thing, which costs credits and looks
  like success. The same rule refuses `aspectRatio` on a grounded model (the
  output takes the reference's shape) and `strength` anywhere but
  image-to-image. One function, `checkRequest` in `fal.ts`, holds all of it and
  runs twice — in the capability layer before any budget is drawn down, and
  again inside `submit` so the seam cannot be bypassed.
- **`imageUrl` accepts an asset id**, and that is the normal case: the
  reference is nearly always a still this system just generated. Project assets
  are not publicly readable and fal fetches the URL itself, so an asset is read
  from R2 and **inlined as a data URL** (3MB ceiling, image kinds only). A
  signed asset URL (plans/003 §5) would replace that mechanism and nothing
  else. `generate_3d` takes the same argument with the same meaning — it used
  to demand a public URL.
- **A post link is a second front door** (2026-09-17). `import_social_video`
  reads a post through SocialCrawl and downloads the video *in the same call*,
  because the only link a login-gated post comes with is signed and expires
  within the hour. The result is an ordinary video asset, so `get_shots` and
  everything after it works unchanged. Instagram only for now.
- **Some models are priced by what they make** (2026-09-17). The Seedance
  entries bill in **tokens** — width × height × seconds × 24 / 1024, plus
  reference video at 0.6x — at a per-endpoint price read from fal's pricing
  API, so a roster entry may carry a `price(req)` alongside its fixed
  `credits`. The family differs only in that unit price: `seedance-2.5-ref`
  is $0.0214 per 1000 tokens, `seedance-2.0-ref` $0.014, `seedance-2.0-mini-ref` $0.007, so a 5s 480p
  test costs ~$0.34 on mini against ~$1.04 on 2.5. (Pricing from the rounded
  per-second figures on fal's model pages overcharged by ~6%.) Mini is capped
  at 9 reference images and 4–15s; out-of-range lengths are refused rather
  than clamped, since a clamp bills a different clip from the one asked for. A `propose_plan` asset item for such a model takes
  `durationSec` / `resolution` and is priced from them; without them the
  typical-call figure (10s at 480p) stands in, which budgeted a 15s 2.5 clip
  at 313 credits against a real 469 — and the gate then refused the call the
  plan was made for. `credits` stays the *typical* call, which is what a plan estimate
  multiplies; the budget gate draws down the real price, so an underestimated
  plan is refused at the call that overruns it rather than overspent.
  `durationSec` is required on such a model: "auto" cannot be priced.
- **References are named in the prompt** and move by upload, not inline.
  `referenceImages` / `referenceVideos` become @Image1… / @Video1… in the order
  passed; project assets are put on fal's CDN (an unguessable public URL — the
  same exposure as sending the bytes for inference). Reference videos must be
  asset ids, because their length is part of the price, and each must be
  1.8–30.2s. **The clip being cloned is never a reference** — see
  docs/recipes.md; pass per-shot control tiles instead.
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
- **Geometry sugar compiles to dumb points** (plans/011 gap 7). `add_arc`
  makes a circle, ellipse, arc or regular polygon and produces an ordinary
  `path` — the document keeps no radius, no angles and no memory of being a
  circle, exactly as `plot_function` keeps no formula. So the result writes on,
  fills, morphs and is ridden by `flow_along` with no special case anywhere.
  It saves **output tokens rather than calls**: `add_path` already took every
  point at once, but two milestone runs still had to *compute* them, one of
  them twice in a single run at 72 points each. `x`/`y` are the centre; equal
  `rx`/`ry` is the only thing that makes it a circle; and on a closed full turn
  `samples` **is** the number of sides, so 3 is a triangle and 64 reads as
  smooth. Angles are radians from 3 o'clock, increasing **clockwise** because
  canvas y points down — the same sense `rotation` turns in — and a sweep past
  a full turn is reported with the radian value that was probably meant, since
  passing degrees draws a plausible whole ellipse and is otherwise invisible.
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
- **A failure under `?format=json` is JSON too** (plans/013). It used to answer
  `text/plain` whichever format was asked for, so a caller that parses every
  reply hit a parse error on *every* capability error — the best teaching
  surface in the system, reaching a program as a crash. The body is now
  `{"error": {message, status, kind?, revision}}`, with the prose verbatim in
  `message`; the text door is untouched, because a model reads prose and must
  not start receiving JSON because a sibling caller wanted some. `kind` is one
  of `invalid_args`, `unknown_capability`, `wrong_executor`, `not_found`,
  `rejected`, `forbidden`, `gated` — **set only where the throwing site knew
  it, never inferred from the status**, since 403 covers both "not your
  project" and "the human has not approved that asset". Absent means read the
  message. The tenancy gate is the one place a status *is* the meaning (404 no
  such project, 403 not yours) and is read back accordingly; the first cut of
  this shipped `kind: "forbidden"` on a 404 whose own message said "not
  found", which is exactly the lie the field exists to avoid.

- **Several calls, one round trip** (plans/011 gap 8). `execute_batch` takes
  `calls: [{name, args}…]` and runs them in order. It **saves round trips, not
  work**: every call goes through the same executor, the same validation and
  the same handlers, and each still reads the document and submits its own
  edit — measured side by side, twelve calls take the same time either way, so
  what collapses is how many times the agent stops and waits. That per-call
  submit is not laziness but the reason a batch is useful: call *n* sees what
  call *n-1* did, which one composed envelope could not offer.
  Consequently **it is not a transaction** — a failure partway leaves earlier
  calls applied, and the error says so and names `get_history` /
  `revert_to_version`, which undo it in one call. The failing call's message
  is reproduced verbatim with its index, so a batch is never a worse teacher
  than the same call made alone. Structural problems — a paid capability, a
  nested batch, a misspelled name — are refused **before anything runs**,
  because refusing a `render_video` at position 5 after applying four edits
  would be worse than not checking at all. There is deliberately **no way to
  reference an earlier call's output**: you cannot type a `sceneId` you have
  not been told yet, so create a scene in one call and populate it with a
  batch. That is three scenes in six calls rather than forty, and the
  alternative was a small expression language inside the arguments.

## Adding a capability

One catalog entry in `apps/api/src/agent/tools-*.ts` — name, summary, prose
contract, Zod args, optional `result`, optional `costsCredits`, handler — and
it is listed, describable and executable. No MCP worker change, no client
restart, no row to add here. `apps/api` is on **zod v4** (see dev-setup for why
that is load bearing).

Add `result` only if the capability is one a *script* would compute over — the
reads. If you do, add it to the `contractHolds` list in `check-gateway.ts` in
the same change: an unverified contract is worse than none, because a caller
will believe it.

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
