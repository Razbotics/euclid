# 007 — Agent sight: preview frames over MCP (status: built, unproven in a run)

Direction decided 2026-08-15 (after the third milestone run): the agent
cannot see what it makes. This **supersedes**
[plans/006](006-animation-depth.md) as the active direction and returns the
product direction to [plans/003](003-general-video.md) — see "What this
replaces, and why" below.

## The observation

Every quality finding in all three milestone runs came from a **shell**, not
from a tool:

| Run | Found | How |
|---|---|---|
| 1 (quadratic) | texMorph was a cross-fade; no emphasis primitive; `write_on` sliced glyphs | `shot.ts`, reading PNGs |
| 2 (Euler) | only one highlight per node survived | screenshot of a five-box sequence |
| 3 (Bayes) | arrow overlapping `P(A∣B)`; fraction morph illegible for ~0.6s; **`update_node` position patches doing nothing** | a one-off script + `ffmpeg` (since promoted to `shot-project.ts`) |

None of those are visible in `get_project`. The outline confirms a highlight
*exists*; it cannot show that the box landed on the right glyph, that two
nodes overlap, or that a patch which returned `updated` changed nothing.

The third run's position bug is the sharpest case. Seven `update_node` calls
returned success and did nothing. The only thing that caught it was looking
at a picture — an agent without a shell would have shipped it.

It has since been fixed, and the fix makes the point rather than retiring it.
There were **two** traps, not one: a patch naming properties the node lacks
(`{x, y}` instead of `{position:{x,y}}`) was stripped by Zod and reported
success, and a patch to a property an animation keyframes changes the
document but not the render, because the track wins. Both now fail loudly and
both are covered in `smoke.ts`. But neither was *findable* from text — the
first produced a picture that looked unchanged, and the second produced a
document that agreed the move had happened. Knowing to look was the hard
part, and that is exactly what the agent cannot do.

## Why this outranks vertical depth

The launch phase ([000-roadmap.md](000-roadmap.md), moved last on 2026-08-15) is
claude.ai connecting over MCP OAuth. **That agent has no shell**: it cannot
run `tsx`, cannot run `ffmpeg`, cannot decode an MP4. Its only feedback
channel is text. Every visual primitive we have shipped was validated by a
human at a terminal, and the moment that client connects, the validation
disappears.

Moving launch last delays when the shell-less client arrives; it does not
change that we are building for it, and the case does not rest on it. Even
holding a terminal, the loop today is: build blind → spend ~61 credits and
~3 minutes on a render → open the file by hand. There is no way to iterate
on *appearance* cheaply, which is why every run so far has checked the
output once, at the end, instead of while building.

Investing in richer visuals before fixing this compounds output nobody can
check.

## What to build

### 1. `keyMoments(doc)` — pure, in `packages/dsl`

The third run computed the interesting timestamps **by hand three separate
times**: morph midpoints, highlight windows, mid-reveal of a write. The
document already knows all of them.

A pure function returning labeled global times:

```
t=15.91  texMorph  eq_bed0a976  50%   P(A∩B) → P(A∩B) = P(A)P(B|A)
t=19.61  highlight eq_bed0a976  hold  P(B \mid A)
t=34.75  texMorph  eq_bed0a976  50%   → fraction
t=42.05  highlight eq_15ab109f  hold  P(A \mid B)
```

It fits the existing seams exactly: same shape as `scenePacing` /
`pacingSummary`, pure function of the document, testable in `smoke.ts` with
no browser, shared by the editor and MCP. Sampling a transition at 25/50/75%
rather than only 50% is what shows a *trajectory* instead of a single worst
frame.

- [x] `keyMoments(doc)` with per-transition sampling — `packages/dsl/src/moments.ts`
- [x] `smoke.ts` coverage — pure, no browser
- [x] Editor uses it to mark the scrubber (clickable; seeks to the moment)

### 2. `preview_frames` MCP tool

```
preview_frames(projectId, at?: number[], moments?: boolean,
               columns?: number, full?: number)
```

Returns **one contact sheet image**, tiles labeled with their timestamp — not
N separate images. Token arithmetic from the third run: 11 full-res frames
read individually ≈ 15k tokens; a 4×3 grid of 480×270 tiles ≈ 1.1k tokens,
and both the overlapping `P(` at t=34.6 and the off-centre "prior" label are
obvious at tile size. `full: <index>` drills into one frame at full
resolution when a tile looks wrong.

- [x] Contact-sheet composition (grid, labels, scale) — `apps/renderer/src/sheet.ts`
- [x] `preview_frames` registered, defaulting to key moments
- [x] Full-res drill-down for a single frame (`full: <index>`)
- [x] `check-preview.ts` — driven through the gateway as an agent receives it
- [x] Capture backend a Worker cannot be — now `render-worker.ts`, merged
      with the render queue consumer (2026-08-16)
- [x] **Use it in a milestone run.** Everything above is machinery; none of it
      proves an agent *acts* on what it sees. Run 4 (below) says it does: 12
      preview calls, 4 of which changed the video.

### 3. Pricing: free, deliberately

Twelve frames is **0.3%** of a 3,654-frame render. If preview costs credits,
agents will skip it and render instead — 200× more expensive and 3 minutes
slower. This is the same reasoning that keeps `get_project` free, and it is
the whole point: iteration on appearance has to be as cheap as iteration on
structure.

## The obstacle: `apps/mcp` cannot run Chromium

The MCP worker is a Cloudflare Worker. Capture needs a browser. Three paths:

| Path | Cost | Problem |
|---|---|---|
| **Cloudflare Browser Rendering** (Puppeteer binding) | low | a second capture path to keep pixel-identical with `render.ts` — risks quietly violating the purity invariant |
| **The render Container** | none new — `render.ts` already screenshots the canvas per frame | blocked on the Queues/Containers work deferred in plans/002 |
| **Dev-only local path** | lowest | does not solve the shell-less client, which is the entire motivation |

The capture code is **not new work** — this is `render.ts`'s frame loop with a
short time list and a PNG grid instead of ffmpeg. Recommendation: build
Phase A + the sheet composition against the local path so the next milestone
run uses it instead of a throwaway script, and bind it to whichever backend
the render path lands on. **Do not build a second independent renderer** —
the value of a preview frame is that it is pixel-identical to the export, and
that property is worth more than shipping a week earlier.

## What this replaces, and why

[plans/006](006-animation-depth.md) bet that the ceiling was the **visual
vocabulary** — cameras, matrices, projected depth. Three runs say otherwise.
The Bayes run produced a video whose finale reads as deliberate teaching
using only primitives that already exist; what actually limited it was that
finding each flaw required a terminal, `ffmpeg`, and a hand-rolled script.
`shot-project.ts` is now tracked and documented, which makes the loop
repeatable for a *developer* — and makes it obvious that the agent still has
no equivalent.

006 is not wrong, it is **early**. Its own analysis depends on this: it
proposes verifying pseudo-3D "by screenshot at several camera angles" — the
capability this plan builds, which it assumed was free because a human had a
shell.

> **Settled 2026-08-16.** That prediction held: once this plan shipped, 006's
> precondition was met and it was promoted back to the phase *ahead* of
> general video. "Early, not wrong" turned out to be the right call, and the
> thing that unblocked it was exactly the capability named in the sentence
> above.

Returning the direction to [plans/003](003-general-video.md) also lines up
technically rather than merely strategically:

- 003 already plans **proxies, thumbnails and filmstrips** for assets. A
  contact sheet of a project is the same capability aimed at the document.
- 003's WebCodecs move **removes the `page.screenshot()` round-trip**, which
  is exactly what makes frame capture slow enough to need thought. Building
  preview on top of the capture path is a reason to fix that path, and 003
  already argues it "pays for itself on the existing vector path regardless".
- Agent sight is **platform** work, not vertical work. It is worth the same
  to a reel as to a derivation.

The math vertical keeps everything already shipped (matched-glyph morphing,
`highlight`, glyph reveal). What stops is *new* investment in vertical depth
until the agent can verify its own output.

## Honest caveats

- **Stills mislead about motion.** The third run's t=34.6 frame looks
  catastrophic; in motion it is a bad 0.6s, not a broken video. Sampling a
  transition at 25/50/75% shows trajectory but does not fix this. Any verdict
  drawn from frames should say it came from frames.
- **Images are the most context-expensive thing a tool can return.** A tool
  that is easy to call and returns pictures will be called reflexively.
  Default to one sheet, cap the tile count, make full-res deliberate.
- A preview tool makes flaws *findable*, not *fixed*. It would not have made
  the fraction morph legible — it is what proved it wasn't.

## Open questions

- Does `preview_frames` return the sheet as an MCP image block, store it in
  the asset registry and return a URL, or both? An agent needs the block; a
  human reviewing the run wants the URL.
- Should `keyMoments` cap itself on long documents, or page? A 60s video has
  ~12 interesting moments; a 10-minute one has hundreds.
- Does the editor expose the same contact sheet? It would make the "human
  tweaks mid-build" milestone task (still unproven) much easier to land.

## What was built (2026-08-15)

`keyMoments(doc)` → `sheet.ts` (capture + grid) → `render-worker.ts` (the
backend a Worker cannot be, which also drains the render queue) → `preview_frames` in the catalog → an MCP `image`
content block beside its caption. Free, and refused by `execute_paid` so it
stays that way.

Measured on the Bayes project: **12 tiles in 1.2s**, against ~3 minutes and
~61 credits for the render that was previously the only way to look. The first
sheet it produced immediately reproduced the third run's finding — the fraction
morph at t≈34.9s is illegible mid-flight — which had cost a terminal, `ffmpeg`
and a hand-rolled script to find the first time.

### The open questions, answered

- **Image block, stored URL, or both?** Block only. Previews are meant to be
  called constantly; writing each one into the asset registry would bury a
  project's real files under render debris, and the registry had just been
  cleaned of exactly that. A human wanting the picture has the editor, which
  now marks the same moments on the scrubber.
- **Should `keyMoments` cap or page?** Cap, at 12 by default. When the cap
  binds it drops the 25/75% flanking samples before any midpoint, then thins
  what remains *evenly across the timeline* — a cap must never quietly mean
  "only the first half was looked at".
- **Does the editor expose the sheet?** Not the sheet — the moments. Same pure
  function, drawn as clickable markers on the scrubber, so "tile [6] looks
  wrong" is one click from watching it move. That is the half a human needs;
  the sheet exists because the agent cannot scrub.

## Milestone run 4 (2026-08-16) — did it look, and did it act?

"The Derivative as a Limit" (`2ba2fa0f`) — secant slope becoming tangent slope
on `y = x²`, aimed at a pre-calculus viewer. 3 scenes, 160 words, 59.74s,
71 credits (11 TTS + 60 render).

**Caveat on this evidence.** The operator pasted the full run brief, including
the "do not tell the agent any of this" watch list, into the agent's first
turn. So *that it called `preview_frames` at all* is not uncoached, and should
not be counted as proof of unprompted use. What the contamination does **not**
reach is the four findings below: knowing you are supposed to look does not
tell you what you will see, and each of these changed the document.

**It looked 12 times, and it looked while building.** The first call came after
scene 1's static layout and *before a single animation existed* — the
build-time use the plan wanted, not a cheap render at the end. Distribution:
2 calls in scene 1, 8 during scene 2 (the hard scene), 2 at the end. Four were
`full:` drill-downs, always after a tile looked suspicious — the intended
tile→full escalation, never as the first look.

**Four times it acted on what it saw.**

1. **The scale of the whole video changed because of one frame.** The parabola
   was first laid out with a uniform 150 px/unit. The tile looked cramped; the
   `full` drill-down showed why — over x∈[1,2] the curve rises 3 units for 1
   across, so the secant *hugged the curve*, destroying the one contrast the
   video exists to teach. The fix was a non-uniform scale (290 px/unit in x,
   105 in y) and a re-lay of **15 nodes**. Nothing in `get_project` could have
   surfaced this: the outline was correct, the geometry was correct, the
   *picture* was useless. This is the single biggest quality decision in the
   run and it was invisible to every text tool.
2. **`animate` reported success and was wrong by 25×.** Probing the secant's
   pivot, the agent sent `rotation → 11.46` (degrees, from slope 3 to slope 2)
   and got back a truthful `animating line_4f1efa3d.rotation 0 → 11.46`. The
   frame showed the line swung up-and-*left*, well past vertical: rotation is
   **radians**, and 11.46 rad wraps to ≈ −63°. The same frame answered the
   second unknown for free — the pivot is the line's `position`, not its
   midpoint, which is what makes "secant pivots about the fixed point P"
   expressible at all. Correct value: 0.2000 rad. **This is the run-3 pattern
   exactly** — a success message about the document that says nothing about
   the render — and it is the cleanest case yet for why text is not enough.
3. **Two labels occupying the same frame.** A layout check showed "secant" and
   "tangent" both visible, because "tangent" had no reveal gating it. Fixed
   with a `write_on` at 35.3s. A pure-text read would have shown two text
   nodes at two different positions and looked entirely fine.
4. **The equation was overrunning the right edge**, found on the same frame,
   fixed by dropping it to 52px and re-centering.

**It also used sight to confirm a fix, not just to find faults.** Run 3's
sharpest quality flaw was a fraction morph illegible for ~0.6s. This run split
`(2h+h²)/h → 2+h` into *factor* then *cancel* (`h(2+h)/h` in between) and then
sampled all six morph midpoints specifically to check the collapse. All six
were legible. That is the defect not recurring, verified rather than assumed —
and it is the loop the plan was arguing for: cheap enough to check a
hypothesis about appearance mid-build.

**Follow-up fixed 2026-08-16: `rotation` now documents its unit.** The 25×
error was not a bug in `animate` — the document really did get 11.46, and the
tool said so. Only the units could have prevented it, and they were nowhere:
`animate` listed `rotation` among the plain "(number)" properties. It now says
**RADIANS** in the doc with the conversion and the pivot rule, carries
"rotation in radians" in the one-line summary (most calls never reach
`describe`), and `packages/dsl` records it on the field itself. Pinned by
`check-gateway.ts`, which asserts both the doc and the summary.

**Motion caveat, honored.** The agent stated in its own report that the
legibility verdict came from stills and that a still cannot judge whether the
0.5s morph *reads* in motion. The one frame it flagged as odd-looking
(`h + h/h`, mid-factor) it explicitly declined to call a defect for that
reason. The `Remember stills cannot show motion` line in the tool response is
doing real work.

**Cost.** 12 preview calls against 1 render. Had the same four findings been
chased the run-3 way — render, download, `ffmpeg` — they would have cost ~4
renders (~240 credits) and ~12 minutes, and findings 2 and 3 would more
likely have shipped than been found.

### What sight did not fix

- It makes flaws findable, not fixed — as predicted. Every one of the four
  still needed the agent to know what to do about it, and finding 1 cost 15
  correction calls to act on.
- **The `full` drill-down is doing more work than the contact sheet.** Three
  of the four findings were only *confirmed* at full resolution; at tile size
  the secant-hugs-curve problem read as "looks a bit thin". The 4×3 sheet is
  the right default for *scanning*, but the plan's token argument (a sheet
  instead of N full frames) understates how often a real defect needs the
  drill-down. Both are cheap, so this is a note, not a problem.
- No preview call caught a *timing* error, because stills cannot. Timing was
  gotten right by reading word-level timings out of `get_scene` — a text tool.
  Sight and pacing text are complements, not substitutes.

## Milestone run 5 (2026-08-16) — the uncontaminated answer

Run 4's evidence on *did it look unprompted* was worthless: the operator pasted
the brief, watch list included, into the agent's first turn. Run 5 fixed the
method. The agent was given a **subject only** — "a ~60s video on how a sine
wave comes from a spinning circle" — in the operator's own words, with no
brief, no watch list, and no mention that a preview capability exists. The
observation criteria were never written down where they could be pasted; the
run was reconstructed afterwards from the preview backend's log, the document,
and the session transcript.

**It previewed while building, unprompted.** That is the question this plan was
written to answer, and it is now answered without the operator's thumb on the
scale. It also reached for `add_path` and `plot_function` — capabilities that
did not exist when run 4 ran, mentioned nowhere in the request — instead of
approximating a curve with line segments.

The quality claim holds up too, and was checked rather than accepted: the
circle and the wave agree (dot at 9 o'clock with the wave crossing zero at
40.91s; back at 3 o'clock as the period closes at 52.24s). Synchronisation
between two views is a thing no text tool can confirm, which makes it the
sharpest case yet for sight.

One method note for future runs: launch `claude` **from the project directory**.
The first attempt at run 5 was started elsewhere, so the MCP server — registered
per-project — was absent, and the agent sensibly reached for a Python animation
library instead. That is not a discoverability finding, it is an empty tool
list, and the two look identical from the outside. Confirm with `/mcp` before
reading anything into what the agent does.

## Notes / gotchas

- **Two silent-blank-frame bugs, found by the tool on its own output.** Both
  produced a valid PNG of the right size, all black — the failure that looks
  most like success.
  1. Pixi creates its WebGL context without `preserveDrawingBuffer`, so the
     drawing buffer is cleared once the frame composites. Reading the canvas
     from a *second* `page.evaluate` is a later task and gets a cleared buffer.
     Render and copy must happen in one call. `page.screenshot()` never hits
     this because it captures through the compositor.
  2. `render-entry.load()` appended a new canvas per call, all carrying id
     `euclid-canvas`, so `getElementById` kept returning the *first* — which
     nothing rendered into any more. A one-shot script never notices; a
     long-lived capture process gets black frames for every document after the
     first. **This would have hit the render Container too**, and it was fixed
     in the shared surface rather than worked around in the capturer.
- **Blankness cannot be measured from the PNG.** Row filtering turns flat
  regions into zero bytes, so an all-black sheet scored *higher* on a
  byte-level check (1.99%) than a correct busy frame (0.74%) — the first guard
  waved both bugs straight through. It is now measured per tile in the browser,
  where the pixels are, and returned as `x-preview-ink`. That turned a test
  hack into a product safeguard: an all-blank sheet is refused as a capture
  fault rather than handed to an agent that would read it as a broken video.
- Capture and rendering are **one process** as of 2026-08-16
  (`render-worker.ts`), which is what this plan meant by binding capture to the
  render backend: one warm page for previews, a child process per render job,
  and no second renderer to keep in step. The listener is best-effort, so a
  second worker on the same machine just renders.
- The backend is still **local**, which is the last piece. `PREVIEW_ORIGIN` is
  the single seam to move it to the render Container; until then a shell-less
  client is served only where that process runs.
