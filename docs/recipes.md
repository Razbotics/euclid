# Recipes — working procedures for generated video

Recorded from the user, 2026-09-14. These are **process** knowledge, not code:
nothing in the pipeline enforces them, and several steps have no capability
behind them yet. Where that is true this doc says so rather than implying the
recipe is executable today — see [What these recipes still need](#what-these-recipes-still-need).

A recipe is the *order* in which constraints are applied. Both recipes below
are really one idea: **decide what the model is not allowed to invent before
you ask it to invent anything**, because a later correction costs a whole
generation and a control image costs nothing.

## Recipe 1 — cloning a reel

Given a source reel, the working process is:

1. **Scene cuts first.** Split the source on its cuts before looking at any
   frame. Every later step is per-scene, so the cut list is the unit of work.
   (`get_shots` — plans/003 §5; the detector is tuned so a camera move is not
   a cut.)
2. **One best keyframe per scene.** Pick the frame that best represents the
   scene — that is the frame everything downstream is derived from.
3. **Turn each keyframe into a depth tile.** The tile is the control image,
   and it is a composite of three things:
   - **Coarse depth.** Threshold it so it captures the *overall geometry* and
     nothing more. Explicitly **no internal seam detail of garments** — the
     tile carries the shape of the scene, not its texture. Over-detailed depth
     re-imposes the source garment on the generation, which defeats the point.
   - **The face region as a black/white negative**, isolating the face from
     the rest of the depth.
   - **An OpenPose skeleton superimposed**, carrying articulation, which depth
     alone does not.
   - **Colour-coded per scene**, so a tile says which scene it belongs to.
4. **Generate from the tiles** — the subject's own photo as the identity
   reference, the tiles in shot order after it, one scene at a time (see Recipe 2 for when
   scenes may share a pass and when they must not).
5. **Never hand the source clip to the generation.** Not as a reference
   video, not as a start frame. It carries the original performer's face,
   body and look, and a model given it will reproduce them. The tiles are the
   *only* channel from the source to the generation — that is what they are
   for: geometry and pose cross over, the likeness does not. (Added
   2026-09-17, from the user, when Seedance 2.5's video references made the
   shortcut available.)
6. **Everything else is tool editing.** Effects, transitions, overlays, timing
   — these are ops on the document, not things to ask a generation for. A
   generation is for what only a generation can do.

### Notes from the first clone test passes (2026-09-17)

Reel: 14.7s, 11 detected cuts, one gym and one outfit in two setups. Tiles
built for 10 shots; the first 4 generated as 5s tests.

- **The tiles work as layout.** On `seedance-2.0-mini-ref` all four poses
  matched their tiles, the cuts landed in order, the identity came from the
  photo, and nothing of the maps (bands, skeleton, face negative) leaked into
  the picture.
- **Per-shot timing in the prompt is not followed.** Asked for 1.8s / 0.7s, it
  gave ~1.0s / ~1.5s. Retiming is edit work (step 6), so generate shots a
  little long and cut them to the source's timing.
- **Tiles carry no appearance, so the location drifts** — the model invents a
  gym, and a second setup can look like a second room. The background needs
  its own grounding reference (Recipe 2).
- **Building a background plate:** a text-prompted eraser
  (`fal-ai/image-apps-v2/object-removal`, $0.04) cleaned a wide standing frame
  well — and returned it outpainted to 16:9 at 4096×2304, which is fine for a
  look reference. On a frame where the person sat *in* a machine it removed
  the machine too and invented a different room. Take plates from the
  widest, least-occupied frame of the location, and share one plate across
  every setup in that location rather than making one per setup.
- **Bystanders pollute the tiles.** DWPose skeletonises and face-masks every
  person in frame; keep only what sits at the subject's depth (read under her
  own face mask), or the model is told there are extra people.

## Recipe 2 — grounding, and how many passes to use

The rule of thumb behind every multi-scene decision:

> **A single pass of generation has consistent grounding.** Consistency
> *between* passes has to be bought with image grounding.

Which gives three cases:

- **Within one pass** — consistency is free. Prefer one pass wherever the
  content allows it.
- **Across passes that must match** — ground the later generation on an image
  from the earlier one. A frame of a previous scene is the reference that
  makes the next scene continuous with it.
- **Across passes that need not match** — a completely different scene can be
  generated in its own pass with no grounding at all. Do not pay for
  continuity you do not need.

**Grounding** means a reference for any element the generation should carry
over: background, human, garment, accessories, or anything else. It is not a
synonym for "a person".

**A generation need not contain a human.** When it does not, **no pose is
needed** — drop the OpenPose layer from the tile. Depth and any background or
object grounding still apply.

## What these recipes still need

Honest status against the code as of 2026-09-14:

| Recipe step | Capability today | Status |
|---|---|---|
| Scene cuts | `get_shots` | **Exists** (plans/003 §5) |
| Best-keyframe selection per shot | — | Missing; shots come back as times, nothing picks or extracts a representative frame |
| Import the source reel from its link | `import_social_video` | **Exists** (2026-09-17) — SocialCrawl, Instagram only |
| Depth map from a frame | — | Not in the product. fal has the models (`fal-ai/imageutils/depth`, `fal-ai/dwpose` with `body-pose` and `face-mask` draw modes); nothing calls them |
| Face-region negative, pose overlay, per-scene colour coding | — | Not in the product. The first clone test pass (2026-09-17) built tiles with a one-off script outside it — the compositor is the next piece of plan work |
| Generate from identity photo + tiles | `generate_video` with `seedance-2.5-ref` (≤30 images) or `seedance-2.0-mini-ref` (≤9 images, a third of the price — the test pass) and `referenceImages` | **Exists** (2026-09-17), priced in tokens |
| Image grounding on a generation | `generate_image` / `generate_video` take `imageUrl` | **Exists** (2026-09-15). Needs a grounded model — `flux-i2i`, `ltx-video-i2v`, `kling-video-i2v`; a text-only model handed one is refused rather than ignoring it. `imageUrl` takes an **asset id**, so a frame this system generated can ground the next scene directly |
| Effects as tool editing | The whole free capability catalog | **Exists** — this is what the ops surface is for |

**Recipe 2 is executable as of 2026-09-15.** Exposing `imageUrl` turned out to
need more than an argument: the text-to-image endpoints in the roster would
have accepted the field and ignored it, so the change added image-conditioned
roster entries (`fal-ai/flux/dev/image-to-image`,
`fal-ai/ltx-video/image-to-video`,
`fal-ai/kling-video/v1/standard/image-to-video`) and a rule that refuses the
combinations that do nothing.

**Measured 2026-09-15, and it decides how to use the recipe.** The same
reference (a red teapot on a grey table) and the same prompt — "the same
teapot, but glazed deep blue" — through `flux-i2i` at two strengths:

| `strength` | What came back |
|---|---|
| 0.6 | The reference, faithfully: same teapot, same table edge, same window light, same composition — and **still red**. The prompt's colour instruction did not survive |
| 0.95 | A deep blue teapot on a wooden table, differently framed. The prompt won; almost nothing of the reference survived |

So the knob is real (a dropped `strength` would have produced two similar
pictures) and it is a **trade, not a quality setting**: low keeps the grounding
and ignores much of the prompt, high obeys the prompt and loses the grounding.
For continuity between scenes, stay low and change the scene with the tools
rather than with words.

What it still lacks is a **strength knob on video** — `strength` exists for
image-to-image only, because an image-to-video model does not negotiate the
still it opens on.

**Recipe 1 still needs a control-image stage that does not exist in any form.**
The endpoints for it do exist at fal and were confirmed reachable
(`fal-ai/flux-control-lora-depth`, `fal-ai/flux-pro/v1.1/redux`), so the
missing piece is ours: something that extracts depth, isolates the face,
overlays a pose skeleton and colour-codes the result. That is a plan, not a
patch.
