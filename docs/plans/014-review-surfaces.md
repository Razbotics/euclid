# 014 — Review surfaces that mislead (status: proposed)

What the agent is shown about its own work, and the specific ways it is
wrong. Every item below cost something in **milestone run 10** (2026-08-26)
and none of them was findable by reading — three are cases where a surface
reported something true and unhelpful, and an agent that believed it would
have damaged its own video.

Same discipline as plans/011: ranked by what it actually cost, not by
plausibility.

## Milestone run 10 — "A sine wave is a circle, unrolled"

A 13s single-scene explainer: a dot rides a unit circle counter-clockwise
while a second dot rides a plotted `sin(x)` beside it, joined by a tracking
line, with an angle arc sweeping in step and a caption naming the height.

| | |
|---|---|
| Gateway calls | 29 (23 carrying capabilities, 1 failed, 5 tool-level) |
| Capability invocations | 31 |
| Document versions | 22 |
| `execute_batch` | 6 batches carrying 14 calls — **8 round trips removed** |
| `describe` | 3 (`connect`, `propose_plan`, `render_video`) |
| Failed calls | 1, corrected on the next call from the error text alone |
| Credits | **2 spent, 0 wasted**; the render was declined, not failed |

**The caveat, stated first because it limits everything below.** This run was
driven by the session that had just built `execute_batch`, `add_arc`, the
`flow_along` speed profile and composition review. That it reached for all
four proves nothing about whether they are *discoverable* — the same
limitation run 9 recorded, and more severe here. The clean signal is the part
of the surface this session did not write: `plot_function`, `add_axes`,
`connect`, `write_on`, `reorder_node`, `preview_frames`, `sample_at`,
`propose_plan`, `request_review` — all called correctly, three of them after a
`describe`, one wrong (below).

## Ranked findings

### 1. Key moments collapse, so the default review shows almost nothing

`preview_frames` with no arguments — the discovery path, and the one an agent
reaches for first — returned **2 tiles for a 13-second video**. Both `follow`
transitions and the `write` run 0→12s, so all three key moments land on the
same `t=6` and dedupe to one, leaving only the scene open beside it.

Nothing is wrong: the moments genuinely coincide. But a scene built from
*synchronised* motion is the normal case for this kind of video, and it is
exactly the case the default sampling covers worst. Every useful sheet in this
run came from passing `at` by hand.

- [ ] When moments collide, spread the sample rather than deduping to one —
      or always mix in evenly spaced frames so the sheet cannot come back
      near-empty for a scene that is moving throughout.

### 2. The pacing flag is blind to motion, and points at a trap

`get_project` reported `tail=3.62s (long)` and `3.6s silent (28%)` on a scene
whose animation runs to 12s of its 13. The flag compares speech against scene
duration and knows nothing about whether anything is still moving.

That would be a harmless false positive except for where it sends you: the
documented remedy is `fit_scene_to_narration`, which here would cut the scene
to ~10.2s and **truncate the motion mid-revolution**. `fit_scene_to_narration`
warns about truncation in its own doc; nothing connects that warning to the
flag that recommends it. A fresh instance of plans/011 gap 6 — tool
combinations that silently disagree — and the first one found by a run rather
than by reasoning.

- [ ] `(long)` should account for transitions and tracks still running past
      the last word: a scene that is animating is not silent-and-idle.
- [ ] `fit_scene_to_narration` should say what it would truncate *before*
      doing it, the way `reorder_node` reports re-parenting.

### 3. Thin strokes vanish from the contact sheet

A 2px connector between the two dots read as **missing** at `t=3` in a
4-column sheet — the tile is quarter scale, so the line is half a pixel. It is
present in the document, resolves correctly (`sample_at` gave
`from=(498,300) to=(1057,300)`), and is plainly visible in the `full:`
drill-down.

The recovery path worked exactly as designed and cost two calls. But the
failure mode is a picture that says *"you forgot something"* when nothing is
missing, and the obvious response — add the missing element — makes the video
worse. The orientation block warns that stills cannot show motion; it does not
warn that thin strokes cannot survive the sheet.

- [ ] Say it in the `preview_frames` contract, and consider a floor on
      effective stroke width when tiling, or a note when the sheet scales a
      stroke below ~1px.

### 4. `write_on` is the only transition that takes no `easing`

`animate`, `flow_along`, `highlight`, `morph_latex` and the camera moves all
take `easing`; `write_on` does not. The prior does not transfer, which is the
gap-3 failure in a different dress — not a naming inconsistency but a
capability one.

Cost was one call, refused and corrected immediately: the error named the
argument, listed what *is* accepted, and the batch reported `Nothing ran`. The
teaching worked. Whether the reveal should be easable at all is the real
question — its fixed linear ramp is what let it stay in step with a linear
`flow_along` here, which is an argument for leaving it alone and **saying so**
rather than for adding the parameter.

- [ ] Decide it deliberately: add `easing`, or document why the reveal is
      always linear.

### 5. "reversing partway" fires on a profile that never reverses

`flow_along` with `at: [{t:0,u:1},{t:12,u:0}]` — a monotone backwards
traversal, used here to send the dot counter-clockwise — reports *"reversing
partway"*. It never reverses; it runs backwards the whole way. The check is
`u[i] < u[i-1]` anywhere, which is true of any descent.

Cosmetic, and mine from 2026-08-23.

- [ ] Distinguish a descending profile from one that changes direction.

## What worked, recorded so the ranking above is not read as a verdict

- **`execute_batch` was reached for six times unprompted**, removing 8 of 31
  round trips (~26%). It is named in the orientation block's opening section,
  which is presumably why. Its per-call submit was load-bearing rather than a
  compromise: the batch that added a node and then reordered it depends on
  call *n* seeing call *n-1*.
- **The speed profile was necessary, not decorative.** Riding the plotted sine
  needed arc-length fractions, because arc length is not the parameter on a
  curve — a dot placed by plain keyframes would have chord-approximated the
  curve it was supposed to be riding. The profile was computed in a shell; a
  shell-less agent could not have derived it, which is the clearest thing this
  run says about plans/013.
- **Composition review worked on its first real use.** The contact sheet
  arrived beside the question, the block named the moments, and the editor
  rendered the seek strip. The human answered in the editor and
  `record_answer` was correctly unnecessary.
- **The gates held and cost nothing.** Review mode refused nothing wrongly,
  `propose_plan` priced 4 credits server-side, narration landed
  `PENDING REVIEW`, and `list_assets` dropped the marker on approval. Two
  credits spent, none wasted.
- **`add_arc` twice**, once for the unit circle and once for the sweeping
  angle arc — the second with a negative sweep, which is what made it turn the
  right way.

## Notes / gotchas

- A circle's radius should equal the plot's px-per-y-unit if a correspondence
  line between them is to be exactly horizontal. Here 240px and 240px/unit,
  chosen deliberately; a near-miss would have read as a bug in the geometry.
- `add_arc`'s positive sweep is clockwise on screen, so the standard
  counter-clockwise convention needs a negative `endAngle` — or, for a flow, a
  descending speed profile. Both work; the negative sweep is clearer.
- `write_on` on a closed arc draws it along its length at a linear rate, which
  makes it a free "angle sweep" that stays in step with a linear `flow_along`
  over the same window. Worth knowing; it is not written down anywhere.
