# 006 — Complex animation and depth (status: in progress — Phase 4)

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
that is most of Phase A.

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

## Phase B: Structured primitives  (status: planned)
Most of that video's density is structured 2D, not 3D. Highest ratio of
perceived quality to effort.

- [ ] `matrix` node — rows × cols of cells, each a number or LaTeX
- [ ] `tokens` node — a labelled strip, the thing arrows connect
- [ ] Cell addressing: `row(i)`, `col(j)`, `cell(i,j)`, `range(...)` — the
      `highlight` styles from 002 apply unchanged once cells are addressable
- [ ] **Generalise `stagger`** out of `writeGlyphAlphas`: reveal any group
      element by element, in an order the caller picks
- [ ] **Generalise `matchGlyphs`** with a key function: matrix → matrix
      morphs by matching cell contents
- [ ] MCP: `add_matrix`, `add_tokens`, `highlight` extended to cell ranges

## Phase C: Pseudo-3D  (status: planned)

- [ ] Optional `z` on nodes; camera gains `yaw`/`pitch` and a perspective
      parameter
- [ ] Sampler projects `(x, y, z)` → screen and returns a depth per node —
      pure, deterministic, no engine
- [ ] Stage: painter's z-sort, scale by depth, dim with distance. **The cues
      are what sell it**, not the projection
- [ ] `axes3d`, `vector3` (arrow in space), point cloud
- [ ] MCP: `add_vector3`, `add_axes3d`, camera orbit helper

Verify by screenshot at several camera angles: a vector behind another must
be occluded in draw order and dimmer, or it reads as flat overlapping lines.

## Phase D: Flows  (status: planned)

- [ ] `arrow` primitive that **anchors to nodes**, not coordinates, so it
      tracks endpoints as they move
- [ ] Curved paths; path-following animation for a token flowing along one
- [ ] MCP: `connect(fromNodeId, toNodeId)`

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
