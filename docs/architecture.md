# Architecture

Read the root [README](../README.md) first for the component map. This doc
records the load-bearing decisions and their reasoning.

## The purity invariant

Rendering is a pure function of `(document, time)`. The sampler
(`packages/engine/src/sampler.ts`) resolves any node at any `t` with no
accumulated state, no wall-clock, no randomness. Consequences:

- Browser preview and headless export run the same code → pixel-identical.
- Scrubbing is just evaluation at a different `t` — no simulation to replay.
- The export worker double-renders each frame around `stage.whenIdle()` so
  async LaTeX textures never produce half-loaded frames.

Anything that would break this (physics, particles) must be expressed as a
deterministic function of `t` when it's added.

## Document model

`packages/dsl` defines the scene document: project → scenes (sequential on
the global timeline) → nodes (rect/circle/line/path/text/latex/matrix/tokens/
vector3/axes3d/points3/arrow/group), each with an optional `z`, plus an optional
per-scene `camera` that can also orbit. Animation:

- **Tracks** — per-property keyframes (`position`, `opacity`, `fill`, …),
  eased per-segment (`smooth` = 3b1b smootherstep). The generic mechanism.
- **Transitions** — effects not expressible as property keyframes: `write`
  (draw-on reveal), `texMorph` (matched-glyph equation morph — see below),
  `cellMorph` (the same for a matrix, matched by cell contents), `follow`
  (ride a path by arc length) and `highlight` (emphasis, optionally on one term
  inside an equation or a range of matrix cells).

Agent-facing sugar (`animate`, `write_on`, …) lives in the MCP layer and
compiles to tracks/transitions; the document stays low-level and uniform so
the timeline editor and the reducer only deal with one representation.

## Sync: serialized ops + event log (deliberately not CRDT)

Every writer — editor UI, MCP agent, system jobs — submits an `OpEnvelope`
(`baseVersion`, actor, ≤50 ops) to the project's Durable Object. The DO is
the single writer: it applies the envelope through the shared reducer
(`applyOps`), bumps the version, appends the envelope to an event log, and
broadcasts it to all WebSocket subscribers. Stale `baseVersion` → 409, the
writer refetches and rebases (the MCP worker auto-retries ×3).

Why not CRDT: a keyframe timeline has semantic conflicts (two writers moving
the same clip) that CRDTs merge syntactically but wrongly. A single
serialization point with rebase gives simpler semantics, plus free
undo/history from the event log. The editor doesn't even apply its own edits
optimistically — it waits for the WS echo, which at local latencies is
imperceptible and guarantees convergence.

Validation is layered: Zod schema on the envelope (bad shape → 400), reducer
invariants (missing node, duplicate id → 422), and a full-document re-parse
after each envelope so no op sequence can persist an invalid document.

## Equation morphing

`texMorph` pairs glyphs between the two equations and moves the shared ones;
only genuinely new or removed glyphs fade. The earlier cross-fade of two
whole-equation textures put both forms on screen at partial opacity through
the middle, and because each form was centred independently, terms that never
changed still drifted — the `=` visibly slid sideways.

Three pieces:

- **Matching** (`packages/engine/src/texmorph.ts`) — longest common
  subsequence over glyph codes. LCS rather than nearest-match because it
  preserves reading order: matched glyphs can never cross, which is what
  keeps the motion legible. Pure, so it is tested without a browser.
- **Glyph extraction** (`apps/web/src/tex.ts`) — MathJax tags each `<use>`
  with `data-c`, the glyph's codepoint, which is its identity. Positions come
  from measuring the live SVG in a hidden element, because MathJax nests
  transforms and the browser already composes them. The SVG is rasterized
  **once** and each glyph is a sub-texture frame of that bitmap. `<rect>`
  rules (fraction bars, the radical's vinculum) are carried across as glyphs
  too, or they would disappear mid-morph.
- **Rendering** (`pixi/stage.ts`) — a pooled sprite per glyph; a matched
  glyph keeps the same sprite across frames, so an unchanged term is
  genuinely still rather than redrawn.

Glyph addressing also gives `highlight` two styles that act on the type
rather than around it: `color` cross-fades the targeted glyphs to a copy
rasterized in the highlight colour (a recoloured render rather than a tint,
which multiplies and so can only darken a non-white equation), and
`spotlight` fades everything *except* the term — usually the stronger effect
on a busy equation, because it removes competition instead of adding
decoration. `box` and `underline` remain for non-latex nodes and for
whole-node emphasis, and are the fallback whenever the glyph run can't be
located.

The same glyph data powers two more effects. `write` reveals an equation
symbol by symbol in reading order instead of sweeping a mask edge across it,
which used to slice glyphs in half mid-stroke; non-latex nodes still use the
mask. And `highlight`: `findGlyphRun` locates a
sub-expression by rendering the fragment and finding its code sequence inside
the equation, so an agent can say "mark `\frac{b}{a}`" without knowing where
that lands on screen. Its strength ramps in, holds and ramps out — an
emphasis is a pulse, not a wipe. A node can carry a sequence of highlights;
the sampler renders the one whose window contains `t` (the MCP layer keeps
windows non-overlapping), which is what lets narration walk through several
terms of one equation in turn.

Fades are staggered — what leaves goes before what arrives — since a
simultaneous cross-fade is the muddy look being replaced. The provider seam
keeps `getGlyphs` optional: a provider without it still renders correctly via
the original cross-fade.

## Grouping

`group` nodes compose transforms the way any scene graph does: a child's
coordinates are relative to its parent, so rotating a group carries everything
inside it. This was in the document model and the renderer from the start, and
for a long time nothing exposed it — milestone run 5 keyframed an orbiting dot
as sixteen chords per revolution with hand-computed cos/sin, and reported it as
"no transform hierarchy". The hierarchy was there; only the door was missing.
`add_group` plus a `parentId` on every creator is that door, and it turns an
orbit into a single `animate` on the group's rotation.

Worth noting the shape of that failure, because it will recur: an agent cannot
tell "the system cannot do this" from "the system does not offer this", and
will design around the limit it infers. Errors are cheap — a wrong guess costs
one retry — but an inference costs a whole approach.

## Shortening a scene truncates, it does not break

Nothing is deleted when a scene shrinks — keyframes past the new end simply
stop being reached. That makes it one of the quietest traps in the system: the
effect is cut off at the boundary and every frame still looks plausible.
Milestone run 6 lost 1.6s off the end of a 9.5s camera orbit to
`fit_scene_to_narration` and caught it by arithmetic, not by anything the
system said.

`effectsPastEnd(scene, duration)` in `packages/dsl` answers it: every
transition, node track and camera track finishing after a given duration.
Both doors — `fit_scene_to_narration` and `update_scene` — now name what they
cut, worst overrun first. The camera track is the case that got through, being
a scene-level effect with no node to notice it under.

## Flows: anchored arrows and path following

An `arrow` node holds **node ids**, not coordinates. Its endpoints are
recomputed every frame from where those nodes actually are, so a diagram whose
parts move keeps its connections instead of leaving them behind — the whole
difference between this and drawing a line. Either end can also be a fixed
point.

Two pieces make it work:

- **World positions.** `resolveScene` composes every ancestor group's transform
  into an absolute `world` position per node, so an arrow can point at
  something three groups deep. It also indexes nodes by id, which is what
  anchors resolve against.
- **Cell anchors.** An end can name part of a grid —
  `{node: "tok_x", cells: {cols: 2}}` — and the arrow tracks that cell's box
  rather than the middle of the whole strip. Run 6 drew six per-token arrows by
  inventing six proxy circles to point at, which is the shape of a missing
  feature.
- **Extents** (`packages/dsl/src/extent.ts`). An arrow stops at the *edge* of
  what it points at, plus a `gap`. Extents are exact for shapes, grids and
  paths, and **estimated** from font size and length for text and LaTeX —
  measuring would mean waiting for MathJax, which is asynchronous and would
  make an arrow's geometry depend on what happened to be cached. A circle
  reports itself as an ellipse rather than a box, because a bounding box is 41%
  further away on the diagonal and leaves the arrow visibly short.

`curve` bows an arrow sideways as a fraction of the distance, and the head
follows the *curve's* tangent rather than the chord, so it meets its target
square. Two arrows between the same pair with opposite curves separate.

A `follow` transition rides a `path` node by **arc length**, optionally turning
to face the direction of travel. It is the one transition that writes back into
the resolved properties — position, and rotation when oriented — because "where
it is" is exactly what riding a path means. From `start` onward it therefore
beats a `position` track, the opposite of the usual shadowing rule, and
`flow_along` says so when it sees one.

Resolution order in `resolveScene` matters and is deliberate: compose world
transforms → move the followers → compose again → project → resolve arrows. An
arrow anchored to a follower has to see where the follower ended up, and in a
spatial scene it anchors to the *projected* position, so connections track
their nodes round an orbit.

A dangling anchor draws nothing rather than pointing at the origin, which would
look like a bug in the diagram instead of in the call.

## Pseudo-3D by projection

Very little of what reads as three dimensions in a 3blue1brown video is a 3D
engine: it is projected coordinates plus **depth cues**. That matters more here
than it would elsewhere, because projection is arithmetic on (document, time) —
it slots into the sampler, keeps the purity invariant, needs no GPU (the render
container has none), and adds no second renderer.

`packages/engine/src/project.ts` is the whole of it:
`screen = focus + R(pitch)·R(yaw)·(p − focus) · distance/(distance − depth)`.
Axes are **x right, y down, z toward the viewer**, so a larger z is nearer.

The camera gained `yaw`, `pitch` and `distance` alongside its 2D framing, and
the two compose rather than competing: **projection decides where a point lands
on the z=0 plane, framing decides which part of that plane you are looking at.**
Nodes gained an optional `z`.

Three cues carry it, and the cues are what sell it — a projection without them
reads as flat overlapping lines:

- **Painter's order.** Root siblings are sorted far-to-near, stably, with a
  node that has no depth counting as z=0, so a flat label keeps its document
  order among its peers.
- **Scale.** The perspective divide multiplies the node's own scale.
- **Dimming.** Tied to that same divide rather than to raw depth, so one number
  controls the strength of everything and a flatter camera dims less — which is
  what an orthographic view should do.

Geometry that *spans* depth — `vector3`, `axes3d`, `points3` — projects its own
**vertices** instead of riding the node-level projection, because an arrow from
here to there is not one point with one depth. Those nodes keep their view
transform at identity and draw in absolute projected scene space; a point cloud
also sorts within itself.

**Pinned nodes are the way out of the world.** `fixed: true` on a root node
puts it in an overlay container that is a *sibling* of the camera layer rather
than a child, so it ignores pan, zoom, roll and orbit alike and draws over the
scene at its own coordinates. That is the mechanism, and it is the whole
implementation. Milestone run 6 needed it: its caption drifted across the frame
and grew 46% as the space orbited behind it — correct, since a root node really
is in the world, and not what anyone wants of a label. It applies at the root
only; a child inherits its group's transform, so `pin_to_frame` says so rather
than pretending.

Two rules fall out and are worth knowing:

- **Nothing is projected until there is a reason.** A scene with a flat camera
  and no depths is drawn exactly as before: document order, no projection, no
  sort. Turning on 3D is `yaw`/`pitch`, a node with a `z`, or a spatial node
  type.
- **Spatial nodes belong at the scene root.** A group applies its own 2D
  transform to its children, so projecting inside one would apply the camera
  twice. Groups are drawn flat.

A point at or behind the camera is **culled**, not drawn: the perspective
divide flips sign there and the node would land hugely magnified on the wrong
side of the frame. Camera `distance` is bounded and clamped again at sample
time, for the same reason `zoom` is.

Deliberately still not a 3D backend. three.js is justified by lighting,
occlusion or meshes, and by then [plans/004](plans/004-desktop.md) argues the
desktop app has the GPU to make it cheap. Deciding later costs nothing;
deciding now costs the purity invariant.

### Meshes: solids on the same arithmetic

A `mesh` node extends projection from points to **triangles**, and it stays on
the CPU for the same reason everything else here does. The technique is:
project every vertex, drop the triangles facing away, sort what is left by
centroid depth, fill far-to-near, shade each face by Lambert against a fixed
light.

That sort is the only part in real doubt, since per-face painter's ordering is
famously not correct in general — so it was **measured** rather than assumed
([plans/009](plans/009-generative-assets.md)). The same mesh was rasterised
twice from identical geometry, once with painter sorting and once with a
per-pixel z-buffer, and the differing pixels counted over four camera angles:

| | wrong pixels |
|---|---|
| cube / sphere / **torus**, backface-culled | **0.00%** |
| torus, culling off | 0.01% |
| two interpenetrating quads | 11.12% |

So **backface culling is a correctness feature, not an optimisation**: it
removes the inward-facing half, and what remains of a closed surface can always
be depth-ordered — which is why a torus, which occludes itself, comes out
exact. The one real limit is **interpenetration**: sorting whole triangles
cannot interleave two surfaces that pass through each other, and no flag fixes
that. `add_mesh` says so rather than hiding it.

Geometry is a **spec, not a vertex list**. `{kind:'sphere', radius, segments}`
expands to triangles at draw time through the pure `buildMesh` in
`packages/dsl/src/mesh.ts`. A default sphere is 576 triangles; storing those in
the document would push ~100KB through the event log on every op and could
never be typed by an agent. Expansion being pure is what keeps the purity
invariant — it is a function of the node, exactly like `plot_function`'s
sampling. `custom` is the escape hatch an importer would use.

Depth dims the **shade**, not the alpha. A solid fading toward transparent
reads as glass, and you would see the inside of its far wall.

## Structured primitives: matrix and tokens

A `matrix` is a grid of LaTeX cells; a `tokens` node is a labelled strip. Both
are **one node**, and the shape is the point: `highlight` can mark row 1 or
cell (0,2) without anyone working out where they landed, `morph_matrix` can
restate the grid and move the cells that survived, and `write_on` fills it in
cell by cell. Hand-built, a 3x3 matrix is nine nodes whose ids the caller has
to track and whose alignment breaks when the font size changes.

Cells sit on a **fixed pitch** with their contents centred — nothing is
measured. Sizing columns to their contents would mean asking MathJax how wide
`\alpha` renders, which is asynchronous and only knowable after rasterization:
layout would then differ between a cold frame and a warm one, and the purity
invariant says a frame is a function of (document, time) and nothing else. The
cost is that a wide entry can overflow its cell, which `add_matrix` says in its
response and `preview_frames` shows.

`packages/dsl/src/grid.ts` holds the geometry — `cellCenter`, `rangeBounds`,
`cellsInRange` — so the stage, the sampler and the tool layer all measure the
same grid. A `CellRange` is `{rows?: [a,b], cols?: [a,b]}` with inclusive
bounds and an omitted axis meaning "all of it", which is `row(i)` / `col(j)` /
`cell(i,j)` / `range(...)` as one shape rather than four. A range naming cells
the node does not have selects **nothing**, and the tool layer rejects it —
clamping would mark some other row, which looks like it worked.

Both were additive: new node types and a new transition, so existing documents
stay valid and `SCHEMA_VERSION` did not move.

### What the glyph work generalised into

Phase B of [plans/006](plans/006-animation-depth.md) was mostly *extracting key
functions* from the equation morphing built in 002, not writing new animation:

| Was | Is now | Serves |
|---|---|---|
| `writeGlyphAlphas(count, progress)` | `staggerAlphas(count, progress, {rank})` | glyphs, matrix cells, group children |
| `matchGlyphs(from, to)` — LCS over codes | `matchByKey(from, to, key)` | glyphs by codepoint, cells by contents |
| `morphGlyphs` | unchanged | cells are fed to it as pseudo-glyphs on grid positions |

So a matrix restating itself is the same code path as an equation morphing, and
a `write` on a **group** now reveals its children one at a time instead of
sweeping one mask edge across the whole thing. `rank` is where the order lives:
row-major by default, `columnMajorRank` for a matrix built from column vectors.

## Camera

A scene may carry a `camera` — `position`, `zoom`, `rotation`, plus tracks —
and the stage composes it into the node layer's transform:
`screen = canvasCentre + R(−roll)·zoom·(scenePoint − camera.position)`. Pixi
builds exactly that from `pivot`/`position`/`scale`/`rotation`, so there is no
projection step and nothing downstream knows a camera exists. Node
coordinates, glyph geometry and highlight bounds all stay scene-local, which
is what lets a diagram be laid out **larger than the canvas** and read a piece
at a time — the thing a matrix of legible cells needs.

Three decisions worth keeping:

- **Not a node.** A camera inside the tree would inherit its parent's
  transform, and the frame is not something a group can own.
- **Not a new animation mechanism.** Camera tracks are the same `Track`
  shape, sampled by the same `sampleKeyframes`, obeying the same rule that a
  track shadows the base value. `move_camera` is `animate` with three
  properties: it samples the current framing at `start` rather than assuming
  it, so moves chain.
- **The background stays outside it.** `bg` is drawn in the root, not the
  camera layer, so it fills the frame rather than sitting in the scene, and
  zooming out reveals more diagram instead of the edge of the backdrop.

The camera is optional (`camera?`), so documents written before it stay valid
and `SCHEMA_VERSION` did not move. Absent means no transform at all rather than
an identity camera, which is what lets the stage reset cleanly between scenes.

A camera move is also a **key moment**: it re-frames every node at once, so
what it gets wrong is not in any node — the subject ends up half out of frame,
or the zoom settles on nothing. It has no transitions to be found by, so
`keyMoments` reads the camera tracks directly and samples mid-move and where it
settles. The editor draws a mini-map of the frame within the scene while
scrubbing, for the same reason: the preview *is* the camera's view, so the one
thing it cannot show is where that view sits.

## Graphs: the mapping is a node

`plot_function` always owned the mapping and *reported* it — `originScreen` and
`scale` — so a caller could place anything else in the same coordinate system.
That was the right half of the answer, and it left the other half to be done by
hand: every axis line, tick and number derived from the report, every time.

An `axes` node holds the mapping instead: the rectangle it occupies, the
function-space ranges across it, and its ticks. `plot_function` takes an
`axesId` and **borrows** it. So the curve and the frame it is read against come
from one set of numbers rather than two derivations that have to agree — which
is the run-4 failure exactly (a hand-chosen uniform scale made a secant hug its
own curve, and only a screenshot caught it).

`plotMapping(rect, domain, range, uniform)` in `packages/dsl/src/plot.ts` is
that one set of numbers, used by `samplePlot` and by the stage's tick placement
alike.

Two details worth keeping:

- **Ticks land on round numbers.** `niceStep` picks 1, 2 or 5 times a power of
  ten, targeting a readable count. Ticks at 0.714 are worse than no ticks, and
  the arithmetic that avoids them is precisely the kind that goes unchecked.
  Values are snapped to the step's precision, because accumulating a float step
  gives 0.30000000000000004 and a tick labelled that is worse than one a pixel
  out.
- **An axis sits at function-space zero, or at the rectangle's edge.** A graph
  over x ∈ [2,5] draws its y axis on the left rather than far off-screen.

Geometry is absolute canvas coordinates, like a plotted path, so both live in
one space with no second transform to keep in step; group them to move them
together. `write_on` grows the axes out of their crossing point and staggers
the ticks in after.

## Curves

A `path` node holds sampled points and draws them as one polyline. It exists
because a curve was otherwise one `line` node per segment: milestone run 4's
parabola was 9 of its scene's 22 nodes, moved as nine things, and had to be
re-laid nine times when the scale changed.

It is deliberately **dumb** — points, not a formula. Anything that *produces*
the points (plotting `y = f(x)`, mapping a domain onto the canvas) is
agent-facing sugar that compiles down to this, the same split as `animate`
baking keyframes from a sampled current value. The document therefore never
holds an expression, and the purity invariant needs no argument.

Plotting `y = f(x)` sits on top as a capability, not a node type. `samplePlot`
in `packages/dsl` samples an expression over a domain and maps it into a canvas
rectangle, emitting points — so the document holds a curve, never a formula, and
the renderer needs no evaluator. The expression parser (`expr.ts`) is its own
small grammar rather than anything reaching the JS evaluator: a whitelist of
functions, `x`, and five operators, so evaluation is deterministic by
construction and `Math.random()` is simply unreachable.

The mapping is the part that matters. Run 4's expensive mistake was choosing
uniform 150 px/unit for x², where over x∈[1,2] the curve rises three units for
one across — the secant visually hugged the curve and destroyed the contrast the
video existed to teach, and only a picture caught it. So the y range is fitted
to the function by default, `uniform` is opt-in, and the transform actually used
(`originScreen`, `scale`) is **reported back**. That is what lets a caller place
a point on the curve, or a tangent, in the same coordinate system instead of
re-deriving a transform that disagrees.

Write-on is where a path differs from every other node. The generic reveal
sweeps a rectangular mask across the node's bounds, which is right for a line
of text and wrong for a curve: a mask edge reveals by *x position*, so a steep
section appears all at once and a path that doubles back reveals its later half
first. A path instead draws the prefix of itself up to `progress` measured by
**arc length** (`packages/engine/src/path.ts`, pure and browser-free), with the
final segment cut proportionally so a 60-point curve does not reveal in 60
visible steps. Because the reveal is geometry rather than a mask, a partially
drawn path is an open curve — it is never closed or filled until it is whole,
or the fill would grow as a wedge.

## Captions

Subtitles are a **pure function of the document**, the same discipline as
rendering — so they're always current, cost no credits, and need no storage.
`documentCues(doc)` emits cues at whichever fidelity the document supports,
per scene:

- `narration.audio.words` present (from TTS) → word-accurate cues
- narration text only → sentences distributed across the scene in proportion
  to their length, marked `estimated: true` so callers can tell the
  difference instead of trusting inferred timing

Cues respect subtitle conventions (~84 chars, ≤6s, break on sentence ends)
and are lifted from scene-local to global time, then **clamped to the scene**:
generated narration may legitimately outlast its scene (see Narration below),
and an unclamped cue would both describe footage that is no longer on screen
and overlap the next scene's subtitles. Served as SRT or VTT from
`GET /api/projects/:id/captions`, or as JSON for tooling. Captions upgrade
themselves from estimated to exact the moment TTS lands — no migration.

## Assets

Binary files owned by a project — narration audio, generated images, video,
music and 3D models, with ingested footage when the general-video phase lands.
`kind` is one of `audio | video | image | model`. D1 holds the metadata row
(`kind`, `mime`, `bytes`, `duration_sec`, R2 key); R2 holds the bytes under
`assets/<projectId>/<assetId>`.

Assets are **immutable**: a new upload mints a new id rather than replacing
one. That is what makes an `assetId` embedded in a document safe — a
`narration.audio.assetId` can never silently start pointing at different
bytes — and it lets reads cache indefinitely.

Creation (`POST /api/projects/:id/assets`) has two callers. Server-side
producers (TTS, fal, the render worker) present the internal key and are
trusted about `kind`. **The owning user may also upload**, which since the
rights decision in plans/003 — users bring their own media, so there is no
fetcher — is how footage enters a project at all. A user's upload is checked
rather than believed: a type allowlist, a size ceiling, and `kind` taken from
the file's own type rather than the query string, because those disagreeing is
how an image gets filed as audio and becomes invisible to `add_image`. The
bytes stream straight into R2 so a large clip never has to fit in worker
memory, and the D1 row is written only once they land — a document must never
hold an id that resolves to nothing. Reads (`GET /api/assets/:assetId`) are
allowed for the owning user or an internal caller; the render worker uses the
latter to fetch narration audio, and tenancy is enforced by joining through
`projects`, not by trusting the caller.

## Narration (TTS)

`apps/api/src/tts.ts` defines a `TtsProvider` seam — `synthesize({ text,
voiceId }) → { audio, mime, durationSec, words }` — with ElevenLabs behind it.
The provider was chosen for **word-level timestamps**, not voice quality:
timings are what make captions exact and what will let animation anchor to
narration beats. A better-sounding provider that can't say when each word
lands is not a candidate.

The seam is real rather than nominal: the adapter is written against
web-standard APIs only (`fetch`, `atob`) with no Cloudflare types, so it runs
and is tested outside the worker. ElevenLabs reports timing per character;
grouping on whitespace is the whole conversion to the `words` the document
already models.

Synthesis runs in the **API worker**, not the MCP worker, because the API
already owns credits, R2, and the path into the Durable Object — so debit →
synthesize → store asset → submit op is one boundary with one refund path.
Generation is explicit (an MCP tool), never implicit at render time, so the
agent can read the real duration before choreographing against it and the
editor sees narration appear live. See
[plans/002](plans/002-render-pipeline.md) for the wiring.

## Audio tracks

Narration answers "what does this shot say". It does not answer "what does the
video *sound* like", and the two have different shapes — which is why music is
not more narration.

**Tracks live on the document; clips are placed in global time.** A music bed
runs across cuts, so anchoring it to a scene the way narration is anchored
would make it jump whenever that scene's duration changed. The cost is real
and worth naming: re-timing an early scene slides every later scene under a
bed that stays put. Narration keeps the opposite trade for the opposite
reason — a line belongs to the shot it explains.

`doc.audio?: AudioTrack[]`, each with clips carrying `startSec`, an optional
head trim (`sourceInSec`) and length (`playSec`), `gain`, and two fades. It is
optional, so every document written before audio existed stays valid and
SCHEMA_VERSION does not move — the same trick `camera` used.

**`planAudio(doc)` is the one place placement is decided.** It merges generated
narration and every track into a single list of `AudioPlacement`s, and three
consumers read it: the timeline draws from it, the preview mixer schedules
from it, and the render's ffmpeg mux builds its filter graph from it. That is
the same discipline `planNarration` established, for the same reason — the
alternative is an editor that lies about the export. Clips are cut at the end
of the video exactly as narration is cut at the end of its scene.

Muted placements are **included and flagged**, not dropped: the timeline has to
draw a muted lane (you cannot unmute what you cannot see), while the player and
the mux read `audibleAudio`, which filters them. One function, two audiences,
no second definition of "what plays".

Three smaller decisions that each foreclose a bug:

- **`muted` is in the document; solo is not.** Muting changes what the export
  contains, so it is part of the work. Solo is a monitoring choice you make for
  ten seconds — writing it into a shared document would let one person's
  listening silently change everyone's render. Solo lives in editor state.
- **Gain attenuates only (0…1).** `HTMLMediaElement.volume` cannot exceed 1, so
  a document allowing 1.5 would preview at a level it could not export.
- **Fades are evaluated at the playhead** (`gainAt`), so the preview really
  fades rather than promising to. In the mux they come *after* `volume` in the
  filter chain, so a 0.4 bed ramps to 0.4 and never swells to full scale.

Measured end to end on a 19s test render: effects at gain 0.5 read −21.2 dB
against a −15.2 dB source (halving amplitude is −6.02 dB), the 3→6s gap reads
−91 dB, and the bed's 3s fade-out reads −47.4 dB.

## Probing uploaded media

An uploaded file arrives as bytes and nothing more. Duration, dimensions and
frame rate are measured with ffprobe — which the API cannot run, because a
Cloudflare Worker has no subprocesses. So probing lives in the **render
worker**, on the idle side of the poll that claims render jobs: renders first,
probing in the gaps.

That makes measurement asynchronous, and the surfaces say so — `list_assets`
prints "not measured yet" rather than an empty column. `probed_at` is its own
column rather than being inferred from a null duration, because an image
legitimately has no duration and would otherwise be re-probed forever; a file
ffprobe cannot read is marked probed too, since that is a fact about the file
rather than a reason to retry.

## Generative assets (fal)

`apps/api/src/fal.ts` is a second provider seam, shaped after the TTS one and
written to the same rule — web standards only, no Cloudflare types. It covers
images, video, music and 3D models. What differs from TTS is that these do not
answer in one call, so the unit is a **submitted request** rather than a
finished file.

**The queue belongs to the provider.** A request submitted to `queue.fal.run`
is held by fal until collected, so the `generation_jobs` table is bookkeeping —
which project asked, what it cost, what it became — and not a work queue with a
worker draining it. This is the whole reason the feature adds no second
process, unlike renders. The consequence is stated in the tool doc:
`get_generation_status` is what *advances* a job, because nothing else will.

Three decisions worth keeping:

- **Submit before debiting.** A request the provider rejects outright must cost
  nothing, and only the provider knows. Everything after the debit refunds on
  failure — including a failure discovered minutes later during a poll.
- **One path for fast and slow models.** `startGeneration` waits inline for up
  to 20s, then degrades to returning a job id. An image lands in ~3s and making
  the agent poll for that would be a worse tool; a video takes minutes and no
  request can hold that open.
- **The queue URLs fal returns are used verbatim**, never rebuilt from the
  model id — an endpoint with a sub-path (`fal-ai/flux/schnell`) is polled at
  its *app* path, so constructing them would break exactly the models most
  likely to be used.

A model is one **roster entry** — id, kind, price, and the two functions that
build its input and read its output. Adding one costs no new tool, no new route
and no client restart, which is the gateway's argument applied to providers.

What this deliberately does **not** do is display anything. The document has no
image or video node, so a generation is a file in the project's asset tree and
not something in a frame; putting media on a timeline is
[plans/003](plans/003-general-video.md), which wants the WebCodecs capture
rework first. `generate_3d` returns a GLB, and since 2026-08-18 `import_mesh` turns one into
an ordinary mesh node — a dependency-free glTF 2.0 reader
(`packages/dsl/src/glb.ts`), vertex-cluster decimation, and a re-orientation
pass. Two constraints shape it, and neither is about drawing:

- **Winding, not handedness.** glTF is Y-up and this system is Y-down, so the
  conversion negates an axis — which reverses orientation and would leave every
  face pointing inward, rendering as a hollow shell with an identical
  silhouette. `orientOutward` measures the **signed volume** and reverses the
  mesh when it is negative. Every generator in `mesh.ts` yields a positive
  volume, so that single number defines "outward" for the whole system, and it
  works on non-convex shapes where a normal-versus-centroid test does not.
- **The document budget.** Imported geometry lives in the document, the
  document lives under one Durable Object key, and DO values cap at 128 KiB. At
  4,000 triangles the coordinates alone are ~105KB, so `maxImportedTriangles`
  is 2,000 — a storage limit that happens to sit far below the render limit.

Authored solids are unaffected: a sphere is still a few numbers, because
parametric geometry is expanded at draw time. What importing one would take is now measured rather than assumed:
`trellis` returns 10,236 triangles and `hunyuan3d` 329,128, against a 4,000
ceiling, and neither is Draco-compressed. So the work is a glTF parser plus a
decimation pass — roughly 4:1 for trellis, hopeless for hunyuan3d — and not a
decompressor. Scoping it off trellis makes it a much smaller job than the worst
case suggests.

## The capability catalog (agent gateway)

`apps/mcp` is a **relay, not a tool surface** — five fixed tools
(`instructions`, `describe`, `execute`, `execute_paid`, `ask_user`) and no
capability logic at all. Agent-facing verbs live in **one place**:
`apps/api/src/agent/`, a catalog of
capabilities each carrying its name, summary, prose contract, Zod args, a
`costsCredits` flag, and a handler. Three endpoints stand over it —
`GET /api/agent/tools` (orientation + the whole list), `POST
/api/agent/tools/describe` (full contract for named entries), and `POST
/api/agent/tools/:name/execute`. See
[plans/008](plans/008-mcp-gateway.md) for the reasoning and the migration.

Three properties are load-bearing:

- **One implementation surface.** The intent compilation that used to live in
  the MCP worker (keyframes from a sampled current value, morph/highlight
  overlap-replace, the `update_node` track-shadowing warning) now runs beside
  the Durable Object, so a write is one local stub call instead of three
  cross-worker round trips — and the editor can reach the same verbs. The
  heavyweight paths (`services/{assets,narration,render}.ts`) are shared
  outright: the REST routes and the catalog call the same functions, so
  pricing, debit and refund exist once.
- **A fixed tool list.** MCP clients cache `tools/list` at connect, so a tool
  edit used to need a redeploy *and* a client restart — which cost two
  milestone runs their tool coverage. With permanent meta-tools the catalog is
  read at call time, and an edit is live on the next call in the same session
  (measured through a held MCP session: same session id, unchanged tool list,
  new capability text). `CATALOG_REVISION` is derived from the catalog and
  stamped on responses, so a validation error can say the schema moved rather
  than looking like the agent got the call wrong.
- **Paid work is a separate door.** Permissions in MCP clients are per-tool, so
  a single `execute` would let "always allow" quietly cover renders. Credit-
  spending capabilities are reachable only through the paid executor, and each
  door refuses the other's capabilities.

Two things deliberately do **not** move. `ask_user` stays a native MCP tool:
elicitation is a protocol act (the server asks the *client* to open a picker),
and the fallback controls the agent's next reply — neither is expressible as a
request/response capability. And asset **bytes** stay on plain REST, since tool
args are JSON and base64 through an LLM context is a non-starter.

Because validation moved server-side, error text is now the agent's only
teacher — which is why lookups name what *does* exist and rejections name the
capability to call next.

## Agent sight

The agent cannot scrub a timeline, and until now could not see anything it
made: `get_project` confirms a highlight *exists*, never that it landed on the
right glyph. `preview_frames` returns **one labeled contact sheet** — the
capability's caption plus an MCP `image` block — for free, in about a second.
See [plans/007](plans/007-agent-sight.md).

Three properties carry it:

- **Which times.** `keyMoments(doc)` in `packages/dsl` is pure, like
  `scenePacing` and `documentCues`: the document already knows every morph
  midpoint, highlight window and mid-reveal. Morphs are sampled at 25/50/75%,
  because the failure being hunted is usually a trajectory rather than one bad
  frame. The editor draws the same list on its scrubber, so the human and the
  agent are never looking at two different maps.
- **Not a second renderer.** Capture drives the same
  `window.__euclid.renderFrame` the exporter drives, so a preview frame is not
  an approximation of the export — it *is* one frame of it. Frames are composed
  into the grid inside the page, so a twelve-tile sheet costs one image
  transfer rather than twelve `page.screenshot()` round-trips. A Worker cannot
  run Chromium, so capture lives behind `PREVIEW_ORIGIN` — served by
  `render-worker.ts`, the same process that drains the render queue. One
  process, one warm page for previews, a child process per render job; only
  its deployment is still local.
- **Free, deliberately.** Twelve frames is 0.3% of a 3,654-frame render. If
  preview cost credits agents would render instead — 200× dearer and three
  minutes slower — so `preview_frames` refuses the paid executor. This is the
  same reasoning that keeps `get_project` free.

A capture failure and a correctly-rendered dark frame are the same bytes: a
valid PNG of the right size. So the backend measures the lit fraction of each
tile where the pixels actually are (the PNG cannot be asked — row filtering
makes flat regions look like zeros) and reports it; a sheet of **key moments**
that comes back entirely blank is refused as a capture fault rather than handed
to an agent that would read it as a broken video. Explicitly requested times
are exempt: there, "empty" can be the true answer — before a write-on starts,
or when a camera is framing part of the scene where nothing is — and erroring
would report a broken backend for a framing mistake.

Two defects in this path were found while building the camera (2026-08-16),
which is the first feature where "the document changed" and "the picture
changed" come apart cleanly. Both are now asserted in `check-preview.ts`:

- Ink was measured **after** the tile's hairline border was drawn, and the
  border is inside the measured rect. Every tile carried a ~1.2% floor, so a
  blank frame scored 1.15% against a 0.02% threshold and the capture-fault
  guard could never fire.
- The capture cache was keyed on the document's **JSON length**. Any
  length-preserving edit — (960,540) → (200,200), `#ffffff` → `#101418`, a
  duration of 6 → 8 — served the previous frame back as current. It is a
  content hash now.

## Shapes without fills

`fill` is optional on rects and circles: omitted, the shape is an outline. It
had been required, so a ring meant filling with the background colour — which
paints an opaque disc that occludes whatever is behind it and stops working the
moment a background is not flat. `add_shape` takes `fill: "none"` for this.

## Deleting a project

`DELETE /api/projects/:id` (and the `delete_project` capability) is the only
operation with **no way back**: the event log that makes every other mistake
recoverable lives in the Durable Object storage this destroys. Three things
follow from that.

The cascade is ordered **bytes → rows → document → project row**. R2 is the
only store with no foreign key pointing at it, so an object orphaned by a
mid-way failure is invisible and unreclaimable, while an orphaned *row* is
still reachable by `project_id` and cleans up on a retry. So the unrecoverable
work happens first, while the rows that let us find it again still exist. The
project row goes last because the deletion stays resumable — and ownership
stays checkable — for as long as it is there.

The Durable Object gets an explicit `/destroy`, because no SQL delete reaches
the document or the decisions. It clears its in-memory `doc` too: emptying
storage does not evict a live instance, so one that kept its copy would go on
serving and mutating a document that no longer exists anywhere else.

Both surfaces refuse to fire blind. The endpoint takes `?dryRun=1` and the
capability requires `confirm: true`; without them each reports what the
project holds — scenes, duration, assets, renders — and deletes nothing. That
report is what makes a bulk cleanup checkable before it runs.

## Editor entry points

`/` lists every project, newest first; `?project=<id>` opens the editor on
one; `?demo=1` opens a bundled offline document. The list matters more than
it looks: an agent creates projects over MCP and the id only ever appears in
a tool response, so without it the work is invisible unless someone copies a
UUID by hand. Bare `/` used to show the demo, which is indistinguishable
from "connected but not syncing" — the demo now says so on its badge.

## Editor layout: explorer | editor | scene

Three columns, arranged the way a code editor is, because the editor has two
unrelated kinds of sidebar content and stacking them in one column made both
worse:

- **Left — the explorer.** The project's files (`Assets.tsx`), a virtual
  folder tree over `buildAssetTree`.
- **Centre — the editor**, and the only column that grows. A tab strip whose
  first tab is the canvas and whose other tabs are open files.
- **Right — the scene.** The inspector: nodes at the playhead, numeric fields,
  the narration panel. Everything that edits the *document* lives here, so the
  question "am I looking at a file or at the video?" has a side of the screen
  as its answer.

Both side panels collapse to a clickable rail (⌘B / ⌘⌥B, VS Code's own
bindings) and drag to resize from the seam beside them; double-clicking a
handle restores its default width. Open/closed and both widths are remembered
in `localStorage`. The timeline stays full width beneath all three — it is the
transport for the document, not for whatever tab is showing.

Resizing is clamped rather than free: a panel is bounded by what the *other*
panel and a 360px minimum canvas already claim, and the same clamp re-runs on
window resize, so no drag and no narrow window can leave the middle column at
zero. A drag uses pointer capture and recomputes width from where the drag
*started* — accumulating per-move deltas would let the handle drift away from
the cursor every time the clamp bit, and without capture a fast drag would die
the moment it crossed the `<canvas>` or a PDF `<iframe>`.

Two decisions inside that are load-bearing:

- **The canvas is hidden, never unmounted.** Pixi's `Application` and its
  ticker are expensive to rebuild, and unmounting to read a text file would
  restart the preview every time you glanced at one. Opening a file toggles
  `display`, so playback and narration audio carry on behind it.
- **The file list lives in `useAssets`, not in the explorer.** The tab strip
  needs the same records (mime, size, path) to know which viewer to draw, and
  a delete has to close the tab it invalidates. One fetch, one truth.

### Viewing a file

`FileViewer.tsx` renders images (on a checkerboard, so a transparent PNG is
distinguishable from a black one), video, audio, text with a line gutter, PDF,
and glTF/GLB. **`mime` decides, not the extension** — it is what the producer
recorded and what the API serves the bytes back as — but the extension is a
fallback, which matters because fal's 3D models arrived as
`application/octet-stream` before generic mimes were treated as absent, and
those rows are still in projects.

Two limits keep a tab from wedging on a big file, both leaning on the same
range support that makes narration audio seekable (`serveR2Range`): text is
read as a 512KB prefix, and a GLB is read as a 4MB prefix, which is ample
because the spec puts the JSON chunk first.

The model view reports structure — triangles, meshes, materials, textures —
and says so. It is not a render: the engine's mesh node takes *parametric*
geometry (`{kind:'sphere', radius, segments}`), not imported vertices, so
nothing here can put a downloaded model on the canvas. Triangle count is the
number [plans/009](plans/009-generative-assets.md) records for every
generation and the number a future importer has to decimate, so it is the one
worth showing.

## Agent questions

The agent can put a choice to the human rather than deciding alone —
`ask_user` / `get_answer` / `record_answer`, all free. See
[plans/005](plans/005-agent-questions.md) for the reasoning.

Questions are **asked in chat** and **stored** in the project's Durable
Object. Chat because the system may run headless, with no browser open — a
question that exists only in a web panel is a question nobody is asked; the
tool returns a ready-to-paste block and instructs the agent to stop and wait.
The DO copy gives persistence, an audit trail, and a second surface for
whoever does have the editor open, where a question about a moment can offer
to seek to it. Not in `EuclidDoc`, because a decision is workflow state that
never affects a frame; putting it there would bump SCHEMA_VERSION and reach
the renderer.

They broadcast over the same WebSocket as ops, so the editor shows them live
with no new transport, and they persist, so a question asked before the editor
was open is waiting when it opens. The human can answer in the editor or tell
the agent, which records it; `answer.via` keeps the two distinguishable, and
the first answer wins — a second is refused rather than silently overwriting.

## Product ceilings (v1)

1080p max, 30 or 60 fps, 10 minutes per video — enforced by the document
schema and the render endpoint (`packages/dsl/src/limits.ts`). v1 primitives
are LaTeX plus shapes/text/groups. These bound render cost, which is what
credits are priced against.

The active direction is **depth before breadth**: richer animation in the
math vertical — a scene camera, matrices and other structured primitives,
and pseudo-3D — before widening to general video. See
[plans/006](plans/006-animation-depth.md); general video is deferred but not
abandoned in [plans/003](plans/003-general-video.md).

Two properties of the model make both directions cheap. Nodes are a
discriminated union, so `video` and `audio` clip types extend it without a
rewrite. And depth is projection, not a second renderer: `(x, y, z)` → screen
is pure math in the sampler, so it keeps the purity invariant, needs no GPU
(the render container has none), and leaves preview and export identical.

## Render path

`apps/web/render.html` exposes `window.__euclid.{load, renderFrame}`.
`apps/renderer` drives it in headless Chromium, screenshots the canvas per
frame, and pipes PNGs into ffmpeg.

Narration is muxed in the same ffmpeg invocation: each scene's audio asset
becomes an extra input placed at that scene's global start with `adelay`, so
silence between clips falls out of placement rather than needing padding
files. Audio that outruns its scene is cut at the boundary — the same rule
captions follow — so one scene's voice never plays over another's frames.

Placement is `planNarration` in `packages/dsl`, deliberately **not** in the
renderer: the editor's audio preview derives its offsets and trims from the
same function, so what you hear while scrubbing is what lands in the file.
`apps/renderer/src/mux.ts` keeps only the ffmpeg-specific half. This is the
audio counterpart of the purity invariant — but note audio itself stays out of
`packages/engine`, which must remain a pure function of (document, time);
playback lives in the browser shell (`apps/web/src/Narration.tsx`). Target: Cloudflare Containers consuming a
Queue that `POST /render` feeds (queue deferred — see plans/002).

The queue is drained by `apps/renderer/src/render-worker.ts`, which **pulls**:
it claims the oldest queued job through `POST /api/jobs/claim` and spawns
`render.ts` for it. A pull rather than a push because a Worker cannot run
Chromium, so the renderer lives outside Cloudflare and has to come and ask.
Claiming is a conditional `UPDATE ... WHERE status = 'queued'` — the same
trick the terminal states use — so two workers racing for one job resolve by
`changes === 0` rather than by a lock.

One child process per job, deliberately: a render that wedges the browser or
exhausts memory takes its own process down, not the worker, which is also the
shape a container-per-job deployment has. The child drives its own status
transitions, and the worker marks anything that exits without reaching a
terminal state as `failed` — otherwise `rendering` becomes the new `queued`,
a job paid for and never resolved. When this moves to Queues + Containers the
producer changes and `/api/jobs/claim` goes away; the lifecycle either side of
it does not, which is why those transitions live in the API.

Job lifecycle: `POST /render` prices the video (per-second × resolution, see
`packages/dsl/src/limits.ts`), debits credits up front, and creates a
`queued` job. The render worker then drives it — `rendering`, upload the MP4
to R2 via `PUT /api/jobs/:id/output`, `done` — or marks it `failed`, which
**refunds the credits automatically**. Terminal states are final at the SQL
level (the UPDATE matches only non-terminal rows and the refund is gated on
whether it applied), so a retried or duplicated callback cannot double-refund.
Finished videos are streamed back through `GET /api/jobs/:id/download`.

URLs handed to clients are built from `PUBLIC_API_ORIGIN`, never from the
request origin: service-binding calls from the MCP worker arrive with an
internal hostname and would otherwise produce unusable links.

## Auth, credits, tenancy

Better Auth (D1) owns identity; the same instance will back the MCP worker's
OAuth so claude.ai can connect. Credits meter renders + TTS only — agent
iteration must stay free (users burn their own Claude tokens over MCP), so
MCP tools return compact text (outlines, ids) rather than anything expensive.
Projects are single-user in v1; the DO/event-log design already supports
multi-writer, so collaboration is an authorization feature, not a rewrite.

## Dev-only auth bypass

`DEV_ALLOW_ANON=1` (root `.env`) lets sessionless requests act as
`dev-user` so the editor works before auth UI exists. The flag must never be
set in production; the middleware checks the real session first either way.
