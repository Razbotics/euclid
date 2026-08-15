# 007 — Agent sight: preview frames over MCP (status: planned)

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
| 3 (Bayes) | arrow overlapping `P(A∣B)`; fraction morph illegible for ~0.6s; **`update_node` silently discarding position patches** | a one-off script + `ffmpeg` (since promoted to `shot-project.ts`) |

None of those are visible in `get_project`. The outline confirms a highlight
*exists*; it cannot show that the box landed on the right glyph, that two
nodes overlap, or that a patch which returned `updated` changed nothing.

The third run's position bug is the sharpest case. Seven `update_node` calls
returned success and did nothing. The only thing that caught it was looking
at a picture. An agent without a shell would have shipped it.

## Why this outranks vertical depth

[Phase 3](000-roadmap.md) is claude.ai connecting over MCP OAuth. **That
agent has no shell.** It cannot run `tsx`, cannot run `ffmpeg`, cannot decode
an MP4. Its only feedback channel is text.

So the current loop is: build blind → spend 61 credits and ~3 minutes on a
render → receive a URL to a file it cannot open. There is no way to iterate
on *appearance* at all. Every visual primitive we have shipped was validated
by a human at a terminal, and the moment the intended client connects, that
validation disappears.

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

- [ ] `keyMoments(doc)` with per-transition sampling
- [ ] `smoke.ts` coverage — pure, no browser
- [ ] Editor uses it to mark the scrubber

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

- [ ] Contact-sheet composition (grid, labels, scale)
- [ ] `preview_frames` registered, defaulting to `moments: true`
- [ ] Full-res drill-down for a single frame
- [ ] `check-preview.ts` — the tool driven as a real client does

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
| **Dev-only local path** | lowest | does not solve Phase 3, which is the entire motivation |

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
