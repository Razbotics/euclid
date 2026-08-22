# 011 — Agent surface gaps (status: in progress)

What is missing from the capability catalog, ranked by measured cost rather
than by plausibility. The evidence is milestone run 8 (plans/010), which was
driven end to end through the gateway the way any agent drives it — so each
gap below is something that actually cost calls, rebuilds, or a wrong
answer, not something that merely sounds useful. The run-6 lesson frames the
whole list: *an agent cannot tell "the system cannot do this" from "the
system does not offer this", and will design around the limit it infers.*
Run 8 designed around several.

## Ranked gaps

### 1. No draw-order control (highest value)   (status: done)

Ops only append, and draw order **is** document order — so "put the
starfield behind the existing nodes" meant deleting and rebuilding two
entire scenes, which also destroyed the transitions bound to the removed
node ids (`flow_along` and three highlights re-applied by hand). This
happened twice in one run; it was the single largest source of calls.

- [x] A `node.move` op plus one `reorder_node` capability taking exactly one
      of `to: "back"/"front"`, `before`, `after` or `index`. The op won over
      a `node.remove` + `node.add` pair in one envelope — that pair needs the
      node's *contents*, read before the submit, which rebase-on-409 makes
      stale by construction; a move carries an id, so a retry moves whatever
      the node has become. Creators already took `index`, so nothing changed
      there.
- [x] The refusal path: `before`/`after` name a sibling and therefore decide
      the parent, so re-parenting works and is *reported* (a child's
      coordinates are read relative to its group, so the node really moved).
      `parentId: "root"` moves back out. Refused with a remedy: no placement,
      two placements, a node relative to itself, a non-group parent, and a
      group moved inside its own descendant — that last one produces a
      document that still *validates*, because the cycle is simply
      unreachable from `scene.nodes`, so nothing downstream would have caught
      it.
- [x] Verified in pixels (`check-order.ts`): a white disc reads 24.33% lit,
      0.00% under a lid, and 24.33% again once the lid is reordered behind
      it. get_scene can only show that an array changed order.

### 2. Resolved state is only readable as pixels   (status: done)

The sampler is a pure function of `(document, time)`, yet the surface
exposes it only as `get_scene` (the raw document) or `preview_frames`
(pixels). Run 8 computed the moon's beam-crossing window by arithmetic, got
it wrong, and corrected it from tiles — a query would have answered
exactly. `resolveScene` already exists, so this is cheap:

- [x] `sample_at(projectId, sceneId, t)` — free, `t` scene-local (the reply
      states the global time, which is what `preview_frames` takes). Reports
      world position with group transforms composed in, followers already on
      their paths, `screen=` once the camera has framed it, depth/perspective
      in an orbited scene, write/highlight/morph progress, resolved arrow
      endpoints, and `INVISIBLE`/`OFF-FRAME` **with the reason** — "nothing is
      drawn" has four unrelated causes that look identical in a frame.
- [x] Verified against the *renderer*, not against itself: a dot inside a
      quarter-turned group resolves to (400, 500) where the document says
      (200, 0); framing the camera on that answer at 6x reads 8.78% against a
      computed 8.73%, and the raw document position reads 0.00%. A resolver
      that quietly disagreed with the stage would be worse than none, because
      it would be trusted.

### 3. Argument naming is inconsistent, so priors transfer badly

`set_narration` takes `narrationText`, `add_text` takes `textContent` and
`fill`, `preview_frames` takes `at`, a line's `x2`/`y2` are relative while a
path's points are anchor-relative. Every one of run 8's five wrong guesses
was corrected on the next call by the error text — the teaching works — but
each was still a wasted round trip, and the cause was inconsistency, not
ignorance.

- [ ] A naming-convention pass over the catalog: one word for "the text",
      one stated convention for absolute vs relative coordinates, stated in
      the orientation block. Renames are cheap here — the gateway means no
      client restart, and `ref()` keeps the prose honest

### 4. No undo, though the event log exists to provide it

architecture.md itself says the event log gives "free undo/history"; no
capability exposes it. Run 8's scene rebuilds would have been one safe
revert instead of dozens of delete/re-add calls, and review-mode thinking
pairs naturally with it (reject for *documents*, not just assets).

- [ ] `revert_to_version(projectId, version)` — the DO replays or restores;
      the broadcast keeps every editor honest. Needs a decision about
      whether reverting is itself an event (it should be)

### 5. Composition review has no artifact

`request_review` puts **assets** in front of the human, but what run 8
needed the human's eyes on was the *composition* — and the preview sheet
reached them only by being hand-carried through chat. The decision object
already carries `refs`:

- [ ] `refs` gains a preview capture (e.g. `previewAt: number[]` rendered by
      the editor via the capture backend, or an attached sheet asset), so
      "review the video at these moments" is one capability call

### 6. Tool combinations that silently disagree

`flow_along` + `orbit_camera` was a real defect (run 8 finding c): a flat
`path` projects as a node at its anchor while a mesh projects per vertex, so
a follower and its track part company as yaw grows. Each capability is
honest alone; the combination has no voice. The house pattern already
exists — `flow_along` warns about position tracks:

- [ ] `orbit_camera`/`set_camera` (yaw/pitch) warn when the scene contains
      flat paths that moving nodes anchor to or follow
- [x] A second instance of the same class, created by gap 1 and closed with
      it: `reorder_node` can move a spatial node into a group, which silently
      switches its projection off (the sampler only projects unpinned nodes
      at the scene root). The creators never offered `parentId` to a spatial
      node, so nothing before this could reach that state. It now warns, and
      `sample_at` independently reports the consequence as
      `in a group (not projected)`.
- [ ] The real fix — project path points per-vertex like the spatial
      nodes — is renderer work, tracked as future work in plans/010

### 7. Missing geometry sugar

Run 8 hand-sampled circle points twice (the orbit ring, the phase
half-disc). `plot_function` proves the pattern: sugar compiles to dumb
points, the document never holds a formula.

- [ ] `add_arc` (circle/ellipse/arc/polygon generators onto a `path`), the
      same shape `samplePlot` has

### 8. No batch execution

Building three scenes took ~40 HTTP round trips. Scripts do not care;
model-driven agents pay latency per call. Per-call error teaching is the
argument against over-batching, so the middle ground:

- [ ] A batch executor: apply an ordered list of free capability calls,
      stop at the first error, report which succeeded — keeping every error
      as teachable as it is today. Paid capabilities stay excluded, so the
      paid-door permission split is untouched

## Deliberate non-gaps

Known trade-offs, documented elsewhere, not blind spots: STT for uploaded
footage (plans/003 §5), decision expiry/cancel (plans/005), gradient fills
and additive blend modes (the "Tier 2" light vocabulary — plans/010's cone
discussion), the fixed mesh light (a depth cue, not a lighting model), and
text/LaTeX extents being estimated (preview closes the loop by design).

## Notes / gotchas

- The ranking metric is *calls wasted in a real run*, which is why
  draw-order beats flashier items: rebuild-to-reorder cost more than every
  argument mistake combined.
- Items 1, 2, 4 and 8 touch only the API worker and DSL; none move
  SCHEMA_VERSION (reorder is an op; sampling and revert are reads over
  existing state; batch is an executor). Confirmed for 1 and 2 as built.
- **A reorder must move the id, not the node.** The tempting build for gap 1
  is `node.remove` + `node.add` in one envelope — atomic, no new op. It is
  wrong for a reason that never shows up in a single-writer test: `ctx.submit`
  fetches the version and retries ×3 on 409, so the re-inserted node is the
  copy read *before* the conflict, and the retry silently reverts whatever
  landed in between.
- **A cycle passes validation.** Moving a group inside its own descendant
  leaves a document that re-parses cleanly, because the cycle is unreachable
  from `scene.nodes` — the subtree simply stops existing. The reducer has to
  refuse it explicitly; nothing downstream will.
- `findNode` now returns the containing group's id (`parentId`), which is what
  lets a placement resolve "where it is now" without a second walk.
- Ink cannot see *where*. `check-order.ts` asserts the **computed** area a dot
  covers at a known zoom (8.73%), not "some ink" — a dot half out of frame
  still lights the picture and would pass a `> 0` test while sitting somewhere
  else. Framing the camera on the answer is what turns ink into a position
  check, the same trick check-axes and check-flows use.
