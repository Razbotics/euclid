# 006 — Complex animation and depth (status: done — A, B, C and D)

> **Deferred 2026-08-15, promoted back 2026-08-16.** It was parked for one
> stated reason: this plan's own verification step — "verify by screenshot at
> several camera angles" — assumed a capability the agent did not have, and
> [plans/007](007-agent-sight.md) argued the binding constraint was
> verification rather than visual vocabulary.
>
> Both premises have since changed. 007 shipped: an agent can capture labelled
> frames of its own work in about a second, so "verify by screenshot at several
> camera angles" is now a thing it can actually do. And five milestone runs
> have since spent their friction on *missing primitives* rather than on being
> unable to check output — run 5 spent roughly 60% of its calls hand-rolling
> motion the scene graph could have carried. The deferral did its job and its
> precondition is met.
>
> It is now sequenced **ahead of** [plans/003](003-general-video.md), which
> keeps its analysis and its place in the queue. Depth is work on a vertical
> that already produces watchable videos and is checkable in a second; general
> video is a larger bet whose first item is a rights decision.
>
> What landed while this was parked changes the shape of the work below:
> `add_group` gives a real transform hierarchy (a camera is a scene-level
> version of it), `path` and `plot_function` did the graph half, and
> arc-length `write_on` is the start of path-following.

> **All four phases landed 2026-08-16** — camera, structured primitives,
> pseudo-3D, flows — in that order, C and D out of the roadmap's original
> sequence at the user's request. Two items on the roadmap's Phase 4 list never
> had a phase here and remain open: **axes, ticks and labels** for 2D graphs
> (the rest of the story `plot_function` started, still hand-built today) and a
> **code-block primitive** with line-highlight animations. What none of this has
> yet had is a milestone run: every piece is verified in pixels, and none has
> been asked to carry an explanation end to end.

Direction decided 2026-08-15: go deep on the vertical rather than wide across
video. This superseded [plans/003](003-general-video.md) as the active
direction — see "What this replaces, and why" below.

Target: the visual vocabulary of 3Blue1Brown's *Attention in transformers,
step-by-step* — matrices whose cells fill in and light up, vectors in a space
the camera drifts through, structures flowing into other structures.

## The load-bearing observation

Very little of that video is genuinely 3D. What reads as depth is
**projected 3D coordinates plus depth cues** — perspective scale, painter's
z-ordering, dimming with distance. Manim renders it that way; a 3D engine is
not what makes it work.

That matters here more than it does for manim, because projection is pure
math on `(document, time)`:

- It slots into the existing sampler and **keeps the purity invariant**.
- Preview and export stay pixel-identical, with no second renderer.
- It needs no GPU — and [plans/003](003-general-video.md) measured the
  container as having **no H.264 encoder and no GPU**, with WebGL falling
  back to SwiftShader. A real 3D backend would run there worst of all.
- Export is already bottlenecked on one screenshot per frame; heavy 3D makes
  the slowest part slower.

So: **pseudo-3D by projection now.** A real 3D backend (three.js) is only
justified by lighting, occlusion or meshes, and by then
[plans/004](004-desktop.md) argues the desktop app has the GPU to make it
cheap. Deciding that later costs nothing; deciding it now costs the purity
invariant.

## What already exists that this builds on

Not starting from zero. The glyph work from
[plans/002](002-render-pipeline.md) generalises:

| Built for | Generalises to |
|---|---|
| `matchGlyphs` — LCS over glyph codes | matching **cells** between two matrices: matched move, unmatched fade |
| `findGlyphRun` — locate a term by codes | addressing a **row/column/cell** by content |
| `writeGlyphAlphas` — per-glyph reveal | a general **stagger**: any group revealing element by element |
| `drawGlyphs` — pooled sprite per element | pooled sprite per cell/point |

Each of those has `glyph` hardcoded where it wants a key function. Extracting
that is most of Phase B — and it held: see that phase's notes.

## Phase A: Camera  (status: done, 2026-08-16)
Smallest piece, improves everything after it, so it goes first.

- [x] `camera` on the scene: `position`, `zoom`, `rotation`, animated by
      ordinary tracks — no new animation mechanism
- [x] Sampler resolves the camera and returns it with the scene
      (`resolveScene` → `{nodes, camera}`; `resolveCamera` exported separately
      for callers that want the framing without resolving every node)
- [x] Stage composes it into the layer transform
- [x] Editor shows the camera frame while scrubbing
- [x] `move_camera` MCP tool — plus `set_camera` for static framing
- [x] Camera moves are key moments, so `preview_frames` samples them

A diagram larger than the frame becomes legible, which is what lets a matrix
be big enough to read cell by cell.

**Verified in pixels**, not by reading the code — `check-camera.ts` measures
the lit fraction of real capture frames, and every number matched the geometry:
zoom 3 took a disc from 0.56% to 4.95% of the frame (8.8× ≈ 3²), panning away
took it to exactly 0, a node laid out at x=2600 (past the 1920 canvas edge)
went 0% → 1.26% when the camera reached it, an animated push-in read
0.56% → 2.22% → 4.95%, and a quarter-turn roll clipped an 1800×200 bar to 0.6×
its area.

### Decisions

- **Not a node, not a new animation mechanism.** A camera in the tree would
  inherit its parent's transform; the frame is not something a group can own.
  Its tracks are ordinary `Track`s sampled by the same `sampleKeyframes`, and
  `move_camera` samples the framing at `start` exactly as `animate` samples a
  node property, so moves chain.
- **`camera` is optional on the scene**, so no `SCHEMA_VERSION` bump. Absent
  means *no transform*, not an identity camera — which is what lets the stage
  reset between scenes.
- **One op, `scene.setCamera`, sets the camera whole.** Three numbers read
  together mean "the framing"; a partial op would let two writers interleave
  into a framing neither asked for, and there is one camera per scene so
  nothing is saved by splitting it.
- **Two capabilities, not one.** `set_camera` composes (and warns when a track
  shadows what you just set — the `update_node` trap in camera form);
  `move_camera` animates. Framing statically through a 0.1s move would leave a
  track behind and shadow every later `set_camera`.
- **Zoom is bounded (0.05–50), and clamped again at sample time.** The schema
  can bound the base value but not a keyframe — `KeyValue` is one union for
  every property — and a zoom of 0 is a non-invertible transform that blanks
  every frame after it, which reads as a broken renderer rather than a bad
  keyframe.

### Notes / gotchas

Two defects in the **agent-sight** path surfaced here, because a camera is the
first feature where "the document changed" and "the picture changed" come apart
cleanly. Both are fixed and now asserted in `check-preview.ts`:

- **The tile border was inside the ink measurement.** `sheet.ts` measured the
  lit fraction after drawing the hairline that separates tiles, putting a
  ~1.2% floor under every tile. A genuinely blank frame scored 1.15% against a
  0.02% blank threshold, so the "every frame came back empty ⇒ capture fault"
  guard — built for exactly the black-tile bug that path has had before —
  could never fire. Measure before decorating.
- **The capture cache was keyed on the document's JSON length.** Any
  length-preserving edit was invisible and the agent got the *previous* frame
  back, reported as current: `(960,540)` → `(200,200)`, `#ffffff` → `#101418`,
  a duration of 6 → 8. This is how it was found — a camera pan to (200,200)
  produced a frame identical to the one before it. It is a content hash now.

With the ink floor gone, the blank-sheet guard started firing on frames that
are *legitimately* empty, so it now applies only to sheets built from key
moments. An explicitly requested time is a question, and "nothing here" is a
valid answer to it — especially with a camera, where the honest reading is
"your framing is wrong", not "your backend is broken".

## Phase B: Structured primitives  (status: done, 2026-08-16)
Most of that video's density is structured 2D, not 3D. Highest ratio of
perceived quality to effort.

- [x] `matrix` node — rows × cols of cells, each a number or LaTeX
- [x] `tokens` node — a labelled strip, the thing arrows connect
- [x] Cell addressing: `row(i)`, `col(j)`, `cell(i,j)`, `range(...)` — the
      `highlight` styles from 002 apply unchanged once cells are addressable
- [x] **Generalise `stagger`** out of `writeGlyphAlphas`: reveal any group
      element by element, in an order the caller picks
- [x] **Generalise `matchGlyphs`** with a key function: matrix → matrix
      morphs by matching cell contents
- [x] MCP: `add_matrix`, `add_tokens`, `morph_matrix`, `highlight` extended to
      cell ranges

The prediction at the top of this plan held: most of the work was **extracting
key functions**, not writing animation. `writeGlyphAlphas(count, progress)`
became `staggerAlphas(count, progress, {rank})` and now serves glyphs, matrix
cells and group children; `matchGlyphs` became `matchByKey(from, to, key)` and
matches cells by contents with `morphGlyphs` unchanged underneath, cells being
fed to it as pseudo-glyphs on grid positions. A `write` on a **group** reveals
its children one at a time as a free consequence — it used to sweep one mask
edge across the whole thing.

**Verified in pixels** by `check-matrix.ts`: a 2×3 grid fills in cell by cell
(0.42% → 0.58% → 0.74% lit), a 2×2 morphs to 2×4 (0.50% → 0.74%), tokens and
group children stagger, and every error case teaches. Cell *addressing* is the
one claim ink cannot make — it measures how much lit, never where — so that
test **frames the camera on one row at zoom 4**: the same box highlight reads
97% of that frame when addressed to row 1 and 26% when addressed to row 0.
Phase A paying for itself inside Phase B's test.

### Decisions

- **Fixed cell pitch, contents centred, nothing measured.** Sizing columns to
  their contents means asking MathJax how wide `\alpha` renders — asynchronous,
  and only knowable after rasterization, so layout would differ between a cold
  frame and a warm one. That trades the purity invariant for tighter columns.
  A wide cell can overflow; `add_matrix` reports the resulting extent and
  preview_frames shows the collision.
- **One `CellRange` shape, not four verbs.** `{rows?: [a,b], cols?: [a,b]}`
  with inclusive bounds and "omitted = all of it" covers row, column, cell and
  band. The tool layer also accepts a bare index (`{"rows": 1}`) because that
  is the obvious guess, and the nested-tuple-only form would have been the
  `{"position":{...}}` trap again.
- **An out-of-range index is an error, not a clamp.** Clamping marks a
  different row and looks like it worked.
- **`tokens` is its own node type** rather than a 1×N matrix, because its
  content is prose: labels render as text, so a token reads as `cat` rather
  than as italic mathematical variables. It shares the grid, the addressing and
  the stagger; only the drawing differs.
- **Brackets are drawn at full strength during a staggered fill**, so a matrix
  reads as a container being filled rather than as delimiters assembling
  themselves. Deliberate, and easy to change if a run disagrees.
- Both additions are additive — new node types, one new transition — so
  documents written before them stay valid and `SCHEMA_VERSION` did not move.

### Notes / gotchas

- **Brackets were inside-out**, `] [` rather than `[ ]`, because the ticks were
  drawn pointing away from the content. Invisible in every assertion that
  counts lit pixels — the ink is identical either way — and obvious in the
  first frame anyone looked at. Ink says *how much*, never *what*.
- **A settled morph left the brackets on the old shape.** After a `cellMorph`
  completes, the resolved grid is the morph's target while `node.cells` is
  still what the node was born with; the static draw path took its cells from
  the resolved grid and its geometry from the node, so a 2×4 of cells rendered
  inside 2×2 brackets. Anything that needs the shape must read the *resolved*
  cells, which is also why `highlightBounds` consults `res.cellMorph`.
- `packages/engine/src/pixi/stage.ts` contained two **literal NUL bytes** in a
  cache-key template (pre-existing, from before Phase A). `grep` treats the
  whole file as binary and prints nothing, and string-matching edit tools
  cannot match around them. Replaced with `\u0000` escapes — same runtime
  string, greppable file.

## Phase C: Pseudo-3D  (status: done, 2026-08-16)

- [x] Optional `z` on nodes; camera gains `yaw`/`pitch` and a perspective
      parameter (`distance`)
- [x] Sampler projects `(x, y, z)` → screen and returns a depth per node —
      pure, deterministic, no engine
- [x] Stage: painter's z-sort, scale by depth, dim with distance. **The cues
      are what sell it**, not the projection
- [x] `axes3d`, `vector3` (arrow in space), point cloud (`points3`)
- [x] MCP: `add_vector3`, `add_axes3d`, `add_points3`, `orbit_camera`, and
      `yaw`/`pitch`/`distance` on set_camera and move_camera

Verified as this plan asked — by screenshot at several camera angles, plus a
measurement for the claim a screenshot cannot settle. Occlusion is the hard one:
a correct frame and a wrongly-ordered one contain the same shapes. `check-3d.ts`
settles it with a disc painted the **background colour** — invisible against the
backdrop but still occluding — so the same two discs with only their depths
swapped read **6.11% lit one way round and 0.00% the other**, and the only
difference is draw order. Alongside: the same disc draws 2.76x larger when
nearer (2.78 predicted from scale²), an arrow orbited end-on foreshortens
0.76% → 0.55% → 0.07%, a 27-point lattice stays lit through a 120° orbit, and a
cloud reveals dot by dot.

### Decisions

- **Projection and framing compose; they do not compete.** The 3D half maps a
  point onto the z=0 plane in *scene* space, and the existing 2D camera then
  frames that plane. So Phase A's transform is untouched, and one camera object
  carries both without either needing to know about the other.
- **Nothing is projected until there is a reason.** A flat camera over flat
  nodes leaves a scene bit-identical to what it was before this existed — no
  projection, no depth sort. 3D turns on with a `yaw`/`pitch`, a node with a
  `z`, or a spatial node type. The corollary is worth telling agents plainly:
  straight on, a cube *is* a square, and that is not a bug.
- **Vertex projection for geometry that spans depth.** A vector is not one
  point with one depth; drawing it that way is precisely the "flat overlapping
  lines" failure this phase was written to avoid. `vector3`, `axes3d` and
  `points3` keep their view transform at identity and draw in absolute
  projected space; a cloud sorts within itself as well.
- **Dimming rides the perspective divide** rather than raw depth, so one number
  sets the strength of every cue and a flatter camera dims less — which is what
  an orthographic view should do.
- **Points at or behind the camera are culled**, and camera `distance` is
  bounded and re-clamped at sample time. The divide flips sign there, and the
  node would land hugely magnified on the wrong side of the frame.
- **`orbit_camera` takes degrees** — the only capability that does. An orbit is
  naturally "a quarter turn", `90` is unambiguous when the argument is called
  `degrees`, and its doc says outright that everything else is radians.
- Spatial nodes belong at the **scene root**: a group applies its own 2D
  transform to its children, so projecting inside one would apply the camera
  twice. Groups stay flat, and the tools say so.

### Notes / gotchas

- **An arrow pointing exactly at the camera vanished.** Mathematically right —
  a segment seen end-on is a point — and wrong on screen: at yaw 0 the z axis
  simply was not there, which reads as a missing feature rather than as depth.
  A degenerate arrow now draws its head as a disc, because a cone seen end-on
  is a disc. Found by looking at the contact sheet, not by any assertion; the
  lit fraction was happily reporting 0.00% as a pass.
- A spatial node in a scene with **no camera** used to draw nothing, because
  the projection had no camera to run through. It falls back to a flat camera
  focused on the canvas centre — the focus matters, since (0,0) would slide a
  deep node toward the corner as it came forward.

## Phase D: Flows  (status: done, 2026-08-16)

- [x] `arrow` primitive that **anchors to nodes**, not coordinates, so it
      tracks endpoints as they move
- [x] Curved paths; path-following animation for a token flowing along one
- [x] MCP: `connect(from, to)` and `flow_along(nodeId, pathId)`

Verified by `check-flows.ts`. Tracking is the claim ink cannot make on its own —
an arrow is lit whether or not it moved — so the test frames the camera on the
corridor the arrow must stretch across *after* its anchor has travelled: 0.00%
before the move, 3.26% after. An arrow baked at creation leaves that frame
empty. Curved pairs cover more than straight ones (5.09% vs 4.88%) because the
two bows separate instead of overlapping, and a token reaches the far end of a
1600px dog-leg on schedule.

### Decisions

- **Anchors are node ids resolved every frame**, against a per-scene index
  built during resolution. That needs absolute positions, so `resolveScene` now
  composes each ancestor group's transform into a `world` position — which also
  means an arrow can point at something nested three groups deep.
- **Stop at the edge, not the centre**, using estimated extents. Exact for
  shapes, grids and paths; estimated from font size and length for text and
  LaTeX, because measuring means waiting for MathJax and would make geometry
  depend on what is cached. `gap` is the escape hatch. A circle reports as an
  **ellipse** — its bounding box is 41% further away on the diagonal, which
  left every diagonal arrow visibly short.
- **`follow` writes back into the resolved properties.** It is the only
  transition that does, because "where it is" is what riding a path means. From
  `start` onward it therefore beats a `position` track — the opposite of the
  usual shadowing rule — and `flow_along` reports the clash when it sees one.
- **Resolution order is load-bearing**: compose world → move followers →
  compose again → project → resolve arrows. An arrow anchored to a follower has
  to see where the follower ended up, and in a spatial scene it anchors to the
  *projected* position so connections track their nodes round an orbit.
- A dangling anchor **draws nothing**. An arrow to the origin looks like a bug
  in the diagram rather than in the call; the tool refuses unknown ids up front,
  and this covers the node being deleted later.

### Notes / gotchas

- **The head slides around its target, and that is correct.** The endpoint is
  the point on the target's boundary *facing the source*, so moving the source
  moves the head even though the target never moved. The first version of the
  test asserted the head stayed put and was simply wrong about the feature; the
  invariant worth asserting is the distance from the target's centre.
- **Widening a struct needs a sweep of its copies.** `Extent` gained a `shape`
  field, and the sampler rebuilt the object field by field when scaling it —
  silently dropping the new one, so every arrow went back to stopping at a
  circle's bounding corner. Spread, then override.

## Deliberately not doing

- **three.js / a real 3D backend.** See the load-bearing observation. Revisit
  only for lighting, occlusion or meshes, and preferably on desktop.
- **A physics or particle system.** Both fight the purity invariant; anything
  added must be a deterministic function of `t`.

## What this replaces, and why

[plans/003](003-general-video.md) argued for going general — assets, clips,
reels — on the grounds that the math niche was the market's lowest
willingness-to-pay segment. That analysis stands and is not being thrown
away; the plan and [market.md](../market.md) stay as written.

What changed is evidence about *sequencing*. The Phase 5 milestone
(plans/002) found the pipeline reliably produces a **correct, synced** video
while the ceiling on whether it is a **good** one sat entirely in the
animation primitives. Going wide before that ceiling lifts means shipping a
general editor that makes mediocre video in every vertical instead of one
that makes excellent video in one.

One problem at a time: make the math vertical genuinely good, then widen.

Work already done under 003 keeps its value either way — the WebCodecs
benchmark, the container's codec findings, and the asset registry from 002
are all prerequisites for general video whenever it resumes.
