# 011 — Agent surface gaps (status: done 2026-08-23)

All eight gaps are closed. One unchecked line remains under gap 6 — projecting
path points per vertex — and it stays unchecked on purpose: it is renderer
work, it is owned by plans/010, and the item this plan took on was the
*warning*, which is what an agent needs while the renderer is what it is. Every
other box here was measured before being ticked.

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

### 3. Argument naming is inconsistent, so priors transfer badly   (status: done)

`set_narration` takes `narrationText`, `add_text` takes `textContent` and
`fill`, `preview_frames` takes `at`, a line's `x2`/`y2` are relative while a
path's points are anchor-relative. Every one of run 8's five wrong guesses
was corrected on the next call by the error text — the teaching works — but
each was still a wasted round trip, and the cause was inconsistency, not
ignorance.

- [x] One word for "the text": `set_narration(narrationText:)` and
      `add_text(textContent:)` both became `text`, and `add_text(fill:)`
      became `color` to match latex/matrix/tokens/axes. The evidence chose the
      name rather than taste — three separate runs reached for `text` and were
      wrong both times, so the catalog was disagreeing with itself and the
      agent's prior was the right one. Both document fields were *already*
      `text`, so the rename removed a divergence rather than adding one.
- [x] The convention is **enforced, not intended**: `BANNED_ARGS` in
      `catalog.ts` maps each settled name's old spellings, and the catalog
      throws at module load if one reappears — same shape as the duplicate-name
      check and `ref()`. Confirmed by reintroducing `narrationText`: the worker
      refused to boot, naming the fix. `fill` is deliberately not banned; on a
      shape it is half of a `fill`/`stroke` pair and means something `color`
      does not.
- [x] Two conventions stated in the orientation block **and checked against
      every schema** in `check-gateway.ts`: *time is scene-local when the call
      names a scene, global when it does not* (exactly three capabilities on
      the global side, and the list is pinned so a fourth cannot appear
      silently), and *`x`/`y` are absolute and place the node; anything else
      geometric in the same call is measured from there* (the axes/plot
      rectangle is the one stated exception).

### 4. No undo, though the event log exists to provide it   (status: done)

architecture.md itself says the event log gives "free undo/history"; no
capability exposes it. Run 8's scene rebuilds would have been one safe
revert instead of dozens of delete/re-add calls, and review-mode thinking
pairs naturally with it (reject for *documents*, not just assets).

- [x] `get_history` (what there is to go back to) and `revert_to_version`.
      Reverting **is** an event, as predicted: a `doc.restore` op carrying the
      target document, submitted as an ordinary envelope, so the version goes
      UP, history stays append-only and a revert can be reverted.
- [x] The broadcast keeps every editor honest — and it costs the editor
      nothing, because a restore is an op and goes through the same shared
      reducer as everything else. `check-live.ts` proves it: rename, rename
      again, revert over HTTP, and the old name returns in the open editor with
      no reload. **There is no code in the editor that knows undo exists.**
- [x] The base problem the plan did not anticipate: **version 0 is not
      reconstructible from the log**, because a project's canvas arrives as an
      argument to `/init` and never as an op. One snapshot (`snap:base`) plus
      `historyFrom` fixes it — written at `/init` for new projects, lazily on
      the next write for older ones, whose history then honestly begins partway
      through instead of pretending to reach 0.
- [x] The rebuild is self-validating: before returning any earlier version it
      replays to the *current* one and compares. Disagreement means every
      intermediate version is equally untrustworthy, so it refuses rather than
      returning something plausible.
- [x] Verified: a deleted latex node comes back under its own id with **both**
      its transitions attached — which is precisely what rebuilding by hand
      cannot do — and reverting the revert puts the deletion back.

### 5. Composition review has no artifact

`request_review` puts **assets** in front of the human, but what run 8
needed the human's eyes on was the *composition* — and the preview sheet
reached them only by being hand-carried through chat. The decision object
already carries `refs`:

- [x] `refs` gains a preview capture (e.g. `previewAt: number[]` rendered by
      the editor via the capture backend, or an attached sheet asset), so
      "review the video at these moments" is one capability call — **done
      2026-08-23**, and it went to `ask_user` rather than becoming a second
      asking surface. `previewAt` captures those moments through
      `preview_frames` over the gateway and returns the sheet **as an image
      block beside the question**, so the MCP worker stays a relay and the
      tile cap, labels and blank-frame detection come along for free.
      The plan offered two shapes and the answer turned out to be *both, for
      different surfaces*. An attached sheet asset was rejected — it would
      land in the user's library with a review status, and the review queue
      renders `assetIds` as things awaiting approval, which a picture to look
      at is not. So: the **image block** serves the chat human (the surface
      plans/005 says always exists, and the one run 8 actually had), and
      **`refs.previewAt`** serves the editor, which renders a row of seek
      buttons — the live canvas at full size, scrubbable, which is the thing a
      contact sheet cannot be. Plural because whether a caption collides is
      rarely answerable from one frame; `context.atSec` stays the single
      "seek here".
      `previewAt` is the one ref with **no consequence** — `planId` and
      `assetIds` change what answering *does*, this only changes what is being
      looked at — and the check asserts the DO does not mistake it for either.
      A failed capture **refuses the whole call** and leaves no decision
      behind: asking about pixels without them puts the human back to hunting
      for frames without saying so, which is exactly the gap.
      Verified in `check-decisions.ts` (both content blocks travel, the block
      names the moments, the ref is stored and inert, a failed capture leaves
      nothing open — and returning no sheet fails it) and in the browser: the
      three seek buttons render and clicking `▶ 2.0s` moves the playhead to
      2.0s / 6.00s.

### 6. Tool combinations that silently disagree

`flow_along` + `orbit_camera` was a real defect (run 8 finding c): a flat
`path` projects as a node at its anchor while a mesh projects per vertex, so
a follower and its track part company as yaw grows. Each capability is
honest alone; the combination has no voice. The house pattern already
exists — `flow_along` warns about position tracks:

- [x] `orbit_camera`/`set_camera` (yaw/pitch) warn when the scene contains
      flat paths that moving nodes anchor to or follow — **done 2026-08-23**,
      and `move_camera` and `flow_along` warn too, because any of the four can
      create the clash and the one that does is the one an agent is reading.
      The condition is "does this camera **ever** leave the plane", tracks
      included: the ordinary way a scene starts orbiting is `orbit_camera`,
      which keyframes yaw from zero, so a base-value check would miss the
      common case entirely.
      **The warning is measured, not asserted.** The divergence is computable
      from the resolver's own numbers — the only thing borrowed from the
      renderer is one line of `syncNode` — and `check-flows.ts` computes it on
      a 500px orbit ring: **5.7px at yaw 0.05, 113.5px at yaw 0.9.** The
      assertion says out loud that if those ever become equal the renderer has
      started projecting per vertex and the warning has become a lie to delete.
      Two things the work itself taught. **Which of the pair is wrong** is the
      useful half and is not obvious: the follower's position is the honest
      projection of where it is, and the flat polyline pinned to one anchor is
      the approximation — so *hiding the path* leaves correct motion behind,
      where run 8 flattened the whole camera and paid for it with the orbit.
      And **the failure is invisible in the wrong geometry**: a first pass
      measured 329px of drift along a straight rail through the camera's focus
      and photographed a bead sitting neatly on its line, because the drift ran
      along the line's own length. The check uses an orbit ring, which is both
      what run 8 hit and what makes the bead visibly leave its curve.
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

- [x] `add_arc` (circle/ellipse/arc/polygon generators onto a `path`), the
      same shape `samplePlot` has — **done 2026-08-23**. A pure `sampleArc` in
      the DSL and one capability over it; the document holds plain points and
      no memory of the radius, the angles or the fact that it was a circle,
      which is what keeps every downstream consumer seeing one shape of thing.
      The four shapes are **one generator**, not four: an arc is a partial
      sweep, an ellipse is unequal radii, and a regular polygon is a closed
      full turn with a small `samples` — so `samples` IS the side count there,
      and no second argument had to be invented for it (`sides` would have been
      two names for one idea, which the gap-3 check now forbids at load).
      Angles are radians from 3 o'clock increasing **clockwise**, matching the
      sense a node's `rotation` turns in, because canvas y points down. The
      degrees mistake is the one this form invites and it is *silent* — a
      90-radian sweep draws a perfectly plausible closed ellipse — so the
      response names it and prints the radian value that was meant.
      Verified by `check-arc.ts`, which is deliberately two halves: the points
      are arithmetic (a 64-gon sits just inside 2πr, a full turn drops its
      duplicate endpoint, four samples make a diamond that pins the clockwise
      convention), and everything else proves it is an *ordinary path*. The
      document is inspected for leftover geometry fields; a camera on the rim
      reads 2.00% while one on the centre reads 0.00% — a ring, which no
      measure of total ink could tell from a disc — and the same call with
      `fill` floods that middle frame to 100%; and `flow_along`'s speed profile
      rides the generated circle to 6 o'clock at a quarter turn. Reversing the
      y term in the generator fails the diamond assertion, which is how the
      convention earned being trusted.

### 8. No batch execution

Building three scenes took ~40 HTTP round trips. Scripts do not care;
model-driven agents pay latency per call. Per-call error teaching is the
argument against over-batching, so the middle ground:

- [x] A batch executor: apply an ordered list of free capability calls,
      stop at the first error, report which succeeded — keeping every error
      as teachable as it is today. Paid capabilities stay excluded, so the
      paid-door permission split is untouched. **Done 2026-08-23** as
      `execute_batch`, and the measurement corrected the framing:
      **it saves round trips, not work.** Twelve `add_text` calls take the
      same wall-clock either way — 286ms against 296ms, median of 7, both
      climbing identically as the document grows — because every call still
      reads the document and submits its own edit. That per-call submit is the
      *reason* it is useful rather than a shortcut not taken: call *n* sees
      call *n-1*'s work, which one composed envelope could not offer. What
      collapses is the number of times the agent stops and waits.
      Because there is no single envelope, it is **not a transaction**, and
      the failure message says so and names `get_history`/`revert_to_version`
      — undo turning out to be the thing that makes partial application
      acceptable rather than alarming. Structural problems (a paid
      capability, a nested batch, a misspelled name) are refused **before
      anything runs**: refusing a `render_video` at position 5 after applying
      four edits would be worse than not checking. Removing that pre-flight
      fails the check, which is how it earned its place.
      It lives in the catalog like any other capability, reaching the
      executor through a new `ctx.runCapability` rather than importing it —
      `AgentCtx` is already where everything a handler cannot do for itself
      lives, and a direct import would close a loop through the catalog at
      module load, where `ref()` and the duplicate-name check run.
      **No reference syntax, deliberately.** An id made inside a batch is not
      available to a later call in it, and that limit is self-evident at
      authoring time — you cannot type a `sceneId` you have not been told.
      The arithmetic decided it: without references, three scenes go from ~40
      calls to 6; with them, to 3. A small expression language inside the
      arguments is not worth the second three.

## Milestone run 9 — measuring what the first four gaps changed (2026-08-23)

Subject: Kepler's second law, 36s, three scenes, built end to end through the
gateway. **95 gateway round trips, zero failed calls.** Runs 4 and 8 had 10
and 5 respectively, every one corrected from the error text; this run had none
to correct.

*Caveat that limits what this proves:* the run was driven by the same session
that had just built gaps 1-4, so fluency with `reorder_node`, `sample_at`,
`revert_to_version` and the naming conventions is **not** evidence they are
discoverable. The evidence is clean only for the parts of the surface this
session did not write — `add_points3`, `add_path`, `flow_along`, `animate`,
`write_on`, `add_latex`, `preview_frames` — all of which were called correctly
first time, from one-line summaries, with five `describe` calls total.

### What the four closed gaps actually did

- **Draw-order (gap 1) came up unprompted and cost one call.** The starfield
  was added last, as an afterthought, exactly as in run 8 — `reorder_node ...
  to: "back"` fixed it without touching the five nodes already in the scene.
  In run 8 this was a scene rebuild, twice.
- **`sample_at` (gap 2) was used to check physics, not layout.** Six calls
  confirmed the planet reaches perihelion at (360, 540) and aphelion at
  (1560, 540), and that it covers 534px near the sun against 262px far away in
  the same two seconds. That is the claim the video makes, and it was verified
  from numbers rather than from tiles.
- **Undo (gap 4) was never needed.** No wrong turn big enough. Not evidence it
  is useless — evidence this run went well.
- **Naming (gap 3): contaminated, unmeasurable here.** Zero argument errors,
  but the session knew the conventions.

### The finding: half the run was one missing capability

**48 of 95 calls — 51% — were `animate`, all of them building two
non-uniform-speed motions along an ellipse.** `flow_along` travels by arc
length at a *constant* speed, and its `easing` is one monotone curve over the
whole traversal, so it cannot express "fast at perihelion, slow at aphelion,
fast again". The only route is a position track, and `animate` takes one
segment per call: 24 calls per motion, twice.

This re-ranks the remaining work. The plan's gap 8 (batch execution) was
measured at ~40 round trips for three scenes; this run spent 48 on a single
effect. But batching is the *weaker* fix — it would make those 48 calls cheaper
without making them fewer, and the agent still hand-solves Kepler's equation
and emits 24 coordinate pairs. Ranked by what each would have removed here:

- [x] **`animate` accepting a list of keyframes** (`keyframes: [{t, value}…]`)
      — **done 2026-08-23**. Verified against the thing it replaces rather than
      on its own: run 9's exact Kepler motion rebuilt in **one call instead of
      24**, and all six sampled positions came back byte-identical. The check
      does the same in miniature — 8 chained calls reproduced by 1, compared at
      seven times including four *between* keyframes, since landing only on
      them would pass even if the easing differed.
      Keyframes before the first `t` are kept, so a list composes with earlier
      calls exactly as `to` does. A late first keyframe warns rather than being
      silently fixed: a track holds its first value backwards in time, so the
      node would show it from the scene's opening. Shape is checked per entry
      against the property's current value — one mistyped entry among hundreds
      is the failure this form invites, and a bare number in a position track
      samples as a number and places the node at (NaN, NaN) with nothing in the
      document looking wrong. `LIMITS.maxKeyframesPerTrack` (500) is the new
      ceiling; there was none while only two could be added at a time.
- [x] **A speed profile on `flow_along`** — **done 2026-08-23**. `at: [{t, u}]`
      with `u` a fraction of arc length: 48 calls → 2, *and* the agent stops
      computing positions, which is the half keyframes could not fix. The path
      stays the source of geometry and only the pacing is given — the whole
      argument for `flow_along` existing.
      A `FlowPoint` is deliberately a `Keyframe` over a different value domain
      (`t` scene-local, `easing` shaping the segment arriving AT the point), so
      the form an agent already learned on `animate` transfers. It is a
      distinct *type* because a keyframe's value may be a point or a colour and
      neither is a position along a curve, and `start`/`duration` are derived
      from the ends of the list so everything that reads a transition's span —
      key moments, the sampler's own `t >= start` gate — keeps working
      untouched. `u` need not be monotone: rising then falling is a node that
      travels out along the path and back, which the response names.
      Verified in the resolver *and* in pixels by `check-flows.ts`: on a
      1600px dog-leg the profile lands exactly on the arc length it names
      ((1100,700) at 1s, where the constant-speed token is 500px behind),
      interpolates between its points by arc length rather than by chord
      ((600,600) at t=0.5, which is u=0.375 and not u=0.5), holds the last
      point after the end, and reverses. The camera framed on that one point
      reads 2.43% / 6.96% / 2.43% as the token arrives and leaves — and with
      the profile ignored in the sampler the same assertion fails, reporting
      (600,400).
      `sampleFlowU` is a deliberate copy of `sampleKeyframes` — written out
      because mapping FlowPoints to Keyframes would allocate on every follower
      on every frame, in the one function the render loop passes through — so
      the check asserts the two agree across segment boundaries and between
      them. A copy nothing compares is a copy that diverges.
- [x] Batch execution (gap 8) — still worth having for the long tail, but it
      is now clearly the third-best fix for the cost it was ranked on.
      **Done 2026-08-23**, and the ranking held: it makes those 48 calls
      cheaper to *issue* without making them fewer, which is exactly why the
      two above it came first.

### Confirmed, with a correction

**Gap 7 (`add_arc`) is real and should include ellipses.** The orbit was
hand-sampled twice, 72 points each — precisely what the plan predicted, and the
plan says "circle/ellipse/arc/polygon", which is right. Note the cost is not in
*calls* (2 `add_path`) but in **output tokens**: a shell-less agent types every
coordinate. That is the argument for the sugar, and the plan's call-based
ranking understates it. **Closed 2026-08-23** — and the ellipse half was the
load-bearing part, since the run's shape was an orbit and a circle generator
would have left it typing points anyway.

### Non-findings, recorded so they are not rediscovered

- `update_node` with `{"transitions": []}` **does** clear a node's
  transitions, which is how `flow_along` was undone. Nothing in the surface
  says transitions are patchable; `update_node`'s prose lists two traps and
  not this. Worth one sentence in its doc.
- An outline printed through a backslash-interpreting shell shows
  `rac{dA}{dt}` for a perfectly good `\frac{dA}{dt}`. This cost two calls to
  disprove and is **not** a system bug — over MCP the text is JSON-encoded and
  never interpreted. Recorded only because it looked exactly like one.

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
- **The evidence picks the name.** Gap 3 looked like a taste question until
  the three runs that guessed `text` were counted. When an agent's prior and
  the catalog disagree and the prior is consistent across runs, the catalog is
  what is wrong.
- A convention nothing enforces has already rotted somewhere nobody has
  looked. Both halves of gap 3 are mechanical: banned spellings throw at
  catalog load, and the time rule's exception list is pinned in
  `check-gateway.ts`. Writing the rule in prose alone would have been the
  third time hand-written orientation text went stale.
- Narrowing the time rule to **moments** came from the check failing:
  `generate_audio` takes a `durationSec`, names no scene, and has nothing to do
  with the timeline. A *duration* is a length and has no frame of reference to
  get wrong — only a moment does.
- **Version 0 is not in the event log.** The plan assumed "the DO replays or
  restores" was the whole design. It is not: `/init` takes the canvas as an
  argument, so replaying from an invented empty document would guess the canvas
  of any project whose shape is not the default. One stored snapshot plus a
  `historyFrom` marker is what makes replay honest, and it is why old projects
  get partial history rather than fake history.
- Replay is compared against reality before it is trusted, and the comparison
  is key-order-independent — otherwise two documents Zod happened to build in
  different orders would refuse a perfectly good undo.
- **Verify a shortcut against the thing it replaces, not on its own.** The
  keyframe list was checked by rebuilding run 9's motion and comparing every
  sampled position with the 24-call version, and the regression check compares
  at times *between* keyframes as well as on them — landing only on the
  keyframes would pass even if the easing or the segment boundaries had
  changed. "It runs and looks plausible" would have proved nothing.
- Ink cannot see *where*. `check-order.ts` asserts the **computed** area a dot
  covers at a known zoom (8.73%), not "some ink" — a dot half out of frame
  still lights the picture and would pass a `> 0` test while sitting somewhere
  else. Framing the camera on the answer is what turns ink into a position
  check, the same trick check-axes and check-flows use.
