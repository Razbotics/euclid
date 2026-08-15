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

The launch phase ([Phase 5](000-roadmap.md), moved last on 2026-08-15) is
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
- [x] `preview-server.ts` — the capture backend a Worker cannot be
- [ ] **Use it in a milestone run.** Everything above is machinery; none of it
      proves an agent *acts* on what it sees.

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

`keyMoments(doc)` → `sheet.ts` (capture + grid) → `preview-server.ts` (the
backend a Worker cannot be) → `preview_frames` in the catalog → an MCP `image`
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
- The backend is still the **local path**. `PREVIEW_ORIGIN` is the single seam
  to move it to Browser Rendering or the render Container; nothing else changes.
  Until then a shell-less client is served only where that process runs.
