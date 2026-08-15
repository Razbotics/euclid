# 006 — Complex animation and depth (status: deferred)

> **Superseded as the active direction on 2026-08-15** by
> [plans/007](007-agent-sight.md), which returns the product direction to
> [plans/003](003-general-video.md). Deferred, not abandoned: the analysis
> below stands unchanged, and the pseudo-3D-by-projection argument is still
> the right answer whenever depth is picked up. The reason for the switch is
> that this plan's own verification step ("verify by screenshot at several
> camera angles") assumes a capability the agent does not have — see 007
> under "What this replaces, and why".

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

## Phase A: Camera  (status: planned)
Smallest piece, improves everything after it, so it goes first.

- [ ] `camera` on the scene: `position`, `zoom`, `rotation`, animated by
      ordinary tracks — no new animation mechanism
- [ ] Sampler resolves the camera and returns it with the scene
- [ ] Stage composes it into the layer transform
- [ ] Editor shows the camera frame while scrubbing
- [ ] `move_camera` MCP tool

A diagram larger than the frame becomes legible, which is what lets a matrix
be big enough to read cell by cell.

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
