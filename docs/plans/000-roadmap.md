# 000 — Roadmap (status: in progress)

Top-level phases from scaffold to launch. Detail lives in per-phase plan
files; this file tracks the big picture.

## Phase 0: Scaffold (status: done)
- [x] Monorepo, DSL + shared reducer, deterministic engine
- [x] Pixi stage: shapes/text/latex, tracks, write-on, texMorph crossfade
- [x] API worker: ProjectDO event log + WS broadcast, Better Auth wiring, Stripe scaffold
- [x] MCP worker with 16 tools
- [x] Editor: live preview, timeline scrub, inspector edits
- [x] Renderer script + Dockerfile; pixel-level verification tooling

## Phase 1: Local E2E (status: done) → plans/001-local-e2e.md
- [x] Local D1 + auth schema, dev anon bypass
- [x] Ops path verified (409 conflicts, invalid-op rejection)
- [x] MCP loop verified (tools → service binding → DO)
- [x] Editor live-sync verified (external op → WS → canvas)
- [x] Root .env/.env.local system + Cloudflare tunnel script
- [x] Better Auth cloud dashboard connected via tunnel

## Phase 2: v1 milestone — 60s narrated equation-morph video E2E → plans/002-render-pipeline.md
- [x] Silent MP4 export verified end-to-end (animation confirmed in the file, not just a file produced)
- [x] Close the render job loop: R2 upload, job status, download URL, refund on failure
- [x] Asset registry (`assets` table + routes) — prerequisite for narration
      audio; also the general-video phase's "assets as first-class" down payment
- [x] TTS adapter interface + ElevenLabs provider (word timestamps)
- [x] Narration audio in R2, wordTimings into the doc
- [x] Captions: SRT/VTT export, document-derived (upgrades to word-accurate when TTS lands)
- [x] Renderer: mux narration audio into the MP4
- [x] Run the milestone: agent builds the full video over MCP, export
      downloads. **Five runs done here** (see plans/002), and a sixth under
      Phase 4 that used the depth primitives; run 5 was given only a
      subject and produced a 67s synchronised circle→wave explainer, rendered
      unattended now that the queue has a consumer.
      The *human tweaks in the editor* half is **deferred** (2026-08-16): five
      runs say the value has come from the agent being able to check its own
      work, not from a human editing mid-build. The live-sync mechanism is
      verified separately by `check-live.ts`, so what is deferred is the
      workflow, not the capability.

Render queue: a **pull-based worker** (`render-worker.ts`) drains it as of
2026-08-16, so a submitted job now finishes unattended. Cloudflare Queues →
Containers remains the production shape and is still deferred; the job
lifecycle lives in the API either side of the claim, so swapping the producer
does not touch it.

## Phase 3: Agent sight → plans/007-agent-sight.md
Direction decided 2026-08-15 after the third milestone run: **the agent
cannot see what it makes.** Every quality finding across all three runs came
from a shell — `shot.ts`, `ffmpeg`, an untracked one-off script — and Phase 3
connects claude.ai over MCP, which has no shell. Its only feedback is text,
so it can confirm a highlight *exists* but never that it landed on the right
glyph. The third run's `update_node` bug (seven position patches returned
success and changed nothing) was caught only by looking at a picture — it
turned out to be **two** traps, both now fixed and both loud:
a patch naming properties the node lacks (`{x, y}` rather than
`{position:{x,y}}`) was stripped by Zod and reported success, and is now
rejected; and a patch to a property an animation keyframes changes the
document but not the render, since the track wins — `update_node` now says
so. Neither fix makes sight less necessary: an agent without a shell still
could not have found the first one.
- [x] `keyMoments(doc)` in packages/dsl — pure, the transition times worth seeing
- [x] `preview_frames` capability returning one labeled contact sheet — **free**
      (12 tiles in ~1.2s, versus ~3 min and ~61 credits for a render)
- [x] Full-res drill-down for a single suspicious frame
- [x] `check-preview.ts`; editor marks the same moments on the scrubber
- [~] Bind capture to the render backend — **no second renderer**. Both halves
      always drove the same `render.html` surface (run 4 verified export frames
      pixel-identical to preview tiles), and as of 2026-08-16 they are one
      process: `render-worker.ts` serves capture and drains the render queue.
      What remains is deployment — that process is still local, so an agent can
      see and export on this machine and nowhere else. Queues → Containers,
      with `PREVIEW_ORIGIN` as the only seam.
- [x] Use it in a milestone run — **done, run 4 (2026-08-16)**. 12 preview
      calls, 4 of which changed the video: the parabola's whole coordinate
      scale (the secant visually hugged the curve, invisible in any text
      tool), a `rotation` animation that reported success while being wrong
      by 25× (radians, not degrees), and two layout collisions. Sight now
      finds the class of bug that used to need a shell. See plans/007.

Preview frames are only trustworthy because of the purity invariant: a
preview frame is not an approximation of the export, it *is* the export.
Building an independent capture path would trade that away.

## Phase 4: Animation depth → plans/006-animation-depth.md
Promoted out of deferral 2026-08-16. It was parked because its own
verification step — "verify by screenshot at several camera angles" — assumed
a capability that did not exist, and because the binding constraint looked
like verification rather than visual vocabulary. Both premises have since
changed: Phase 3 shipped that capability, and five milestone runs have spent
their friction on *missing primitives* rather than on not being able to check
the output. Run 5 spent roughly 60% of its calls hand-rolling motion the scene
graph could have carried.

Ordered ahead of general video deliberately. Depth is work on the vertical
that already produces watchable videos, where each addition is checkable in
about a second; general video is a larger bet whose first item is a rights
decision. Doing the cheap, verifiable one first is not a change of direction —
plans/003 keeps its analysis and its place.

What already landed changes the shape of the remaining work: `add_group` gives
a real transform hierarchy, `path` + `plot_function` did the graph half, and
arc-length `write_on` is the beginning of path-following.
- [x] Camera on the scene (position/zoom/rotation), animated by ordinary tracks
      — a scene-level transform, now that per-node grouping exists. **Done
      2026-08-16**: `set_camera`/`move_camera`, camera moves are key moments so
      `preview_frames` samples them, and the editor draws a mini-map of the
      frame while scrubbing. Verified in pixels by `check-camera.ts`. It also
      turned up two defects in the sight path — the ink measurement counted the
      tile's own border, and the capture cache was keyed on the document's JSON
      *length*, so any length-preserving edit was served a stale frame. Both
      fixed; see plans/006
- [x] Structured primitives: `matrix`, `tokens`, cell-level addressing —
      **done 2026-08-16**. One node per grid, addressed as `{"rows":1}` /
      `{"cols":[0,2]}` rather than by coordinates; `morph_matrix` restates a
      grid and moves the cells that survived. Verified in pixels by
      `check-matrix.ts`, which proves *placement* by framing the camera on one
      row — Phase A paying for itself inside Phase B's test
- [x] Generalise stagger + element matching out of the glyph work in 002 —
      `writeGlyphAlphas` → `staggerAlphas(count, progress, {rank})` and
      `matchGlyphs` → `matchByKey(from, to, key)`. A `write` on a **group** now
      reveals its children one at a time as a free consequence
- [x] Flows: arrows anchored to nodes, path-following along a `path` — **done
      2026-08-16**. `connect` takes node ids and recomputes its endpoints every
      frame, stopping at the edge of what it points at; `flow_along` rides a
      path by arc length. Verified by `check-flows.ts`, which proves tracking by
      framing the camera where the arrow can only reach once its anchor has
      moved
- [x] Axes, ticks and labels — the rest of the graph story `plot_function`
      started. **Done 2026-08-17**: an `axes` node owns the mapping (rectangle,
      ranges, ticks) and `plot_function` borrows it by `axesId`, so a curve and
      its frame come from one set of numbers instead of two derivations that
      have to agree — the run-4 failure, closed at the source. Ticks land on
      round numbers; an axis moves to the rectangle's edge when zero is out of
      range. Verified by `check-axes.ts`, which frames the camera on the point
      the axes claim is (2,4) at 20x: 6.1% lit there against 0.0% two units
      off it
- [ ] Code-block primitive with line-highlight animations
- [x] Pseudo-3D by projection: optional `z`, camera yaw/pitch, depth cues —
      **done 2026-08-16**, out of order at the user's request. `vector3`,
      `axes3d`, `points3`, `orbit_camera`; projection composes with the Phase A
      camera rather than replacing it, and nothing is projected until a yaw,
      pitch or `z` asks for it. Verified by `check-3d.ts`, which settles
      occlusion with a background-coloured mask: the same two discs read 6.11%
      lit and 0.00% with only their depths swapped. Whether it earns its place
      is still a question for a milestone run, not for the code

Done already, and kept here because it is the same plan: matched-glyph LaTeX
morphing, and the `path`/`plot_function` half of the graph primitives.

**Milestone run 6 (2026-08-16)** used all four phases end to end: a 56.8s
narrated explainer of attention, rendered, 69 credits. The primitives carried
it — nothing was hand-rolled and `preview_frames` caught the one composition
error — so the depth work earns its place. It also found five gaps, listed in
plans/006. Three are fixed: the `instructions` block had still been telling
agents "You cannot see the video" two lines under `preview_frames`; the outline
never said what an arrow connected; and shortening a scene silently truncated
whatever was still running, which cost the run 1.6s of a camera orbit. The other two are fixed too: `pin_to_frame`
keeps a caption out of the orbited world, and `connect` takes cell-level
anchors so an arrow can point at one token rather than a whole strip.

## Phase 4.5: Generative assets + mesh solids → plans/009-generative-assets.md
Inserted 2026-08-17 at the user's request, ahead of general video. Two pieces
that arrived together: **fal as an asset provider** (images, video, music, 3D
models) and **real mesh solids** in the renderer. It sits here rather than
inside Phase 5 because every generated file lands in the asset registry Phase 2
already built, so it needs none of Phase 5's capture rework.
- [x] Mesh feasibility settled by measurement, not opinion — the same solid
      rasterised under painter's-algorithm sorting and under a per-pixel
      z-buffer, differing pixels counted. **Backface culling turns out to be a
      correctness feature**: with it on, ordering is *exactly* right (0.00%
      wrong) even on a torus, which occludes itself; interpenetrating surfaces
      are the one real limit (11.12%) and no flag fixes them
- [x] `mesh` node + `add_mesh` with six parametric shapes, flat Lambert
      shading, a 4,000-triangle ceiling checked before anything is built.
      Geometry is a **spec, not a vertex list** — a sphere is a few numbers in
      the document rather than 576 triangles through the event log. Verified by
      `check-mesh.ts`: a background-coloured solid takes a bright disc from
      13.7% lit to 0.00%, and culled/unculled agree to 0.00%
- [x] fal provider seam + `generate_image` / `generate_video` / `generate_audio`
      / `generate_3d` / `get_generation_status`. **The provider's queue is the
      job queue** — a `generation_jobs` row is bookkeeping, so this adds no
      second process, unlike renders. Verified end to end by `check-fal.ts`
      (a real image, checked to its magic bytes, debited once, refunded in full
      on failure, idempotent under polling) and the slow path by a real
      `ltx-video` clip collected at +100s
- [x] **All eight roster models verified end to end** (2026-08-17,
      `check-fal-roster.ts`, ~$0.50): every output reader exercised against a
      real successful result, with the stored bytes identified by **magic
      number** rather than the claimed mime. Both GLBs parse as valid glTF 2.0;
      `stable-audio` returned exactly the requested 10.0s, which checks the
      input builder too. Found and fixed one real defect: both 3D models report
      `application/octet-stream`, so every generated model was being stored
      under a mime that says nothing — generic mimes are now treated as absent
- [ ] GIF has no roster entry: the category is served by video models that
      return mp4, so a real GIF path is an ffmpeg transcode
- [x] **GLB import — `generate_3d` now produces something the engine draws**
      (2026-08-18). A dependency-free glTF 2.0 reader in the DSL, vertex-cluster
      decimation, and `import_mesh`. Verified end to end by `check-glb.ts`: a
      real trellis model at 10,132 → 1,382 triangles, rendered as a recognisable
      owl. Two findings worth keeping:
      **(a)** converting glTF's Y-up to this system's Y-down negates an axis,
      which reverses winding and would render every import as a hollow shell
      with an identical silhouette — the cylinder bug by another route. Fixed by
      measuring **signed volume** (positive = outward, as every generator here
      produces) rather than reasoning about handedness, which also works on the
      non-convex shapes an `n · centroid` test cannot handle.
      **(b)** the binding limit is the **document**, not the frame: imported
      geometry is stored in the document, which lives under one Durable Object
      key capped at 128 KiB, and 4,000 triangles serialise to ~105KB. Hence
      `maxImportedTriangles = 2000`, and a projected-size refusal that names the
      argument to lower

**Milestone run 7 (2026-08-17)** — a 32.6s narrated Archimedes explainer
(sphere : cylinder : cone), built entirely from primitives with an orbiting
camera and rendered. The mesh work earns its place: nothing was hand-rolled, and
four `preview_frames` calls covered the whole build. It found four defects, all
now fixed, and the first is the one worth remembering:

- **The cylinder was inside out** — all 64 faces wound inward, so culling kept
  the far wall and dropped the near one, and it rendered as an open cup. It
  survived `check-mesh.ts` because an inverted solid has the *same silhouette*
  as a correct one: culled and unculled read `0.14787` both, identical to five
  decimals. The remedy is not another pixel test but a **pure winding
  invariant** (`n · centroid > 0` for a convex solid), which names the exact
  face count and was confirmed to fail when the bug is re-introduced
- **A shape could be born unfilled but never made unfilled**: `add_shape`
  teaches `fill: "none"`, `update_node` rejected that word, and the reducer's
  actual removal signal (`null`) was undocumented. Both spellings now work
- **The outline could not tell a sphere from a cone** — it printed a bare
  `mesh <id> @(x,y)`. Now `cone r=180 h=360 80tri`. This is run 6's arrow
  finding recurring, which says the outline is where a new primitive is most
  likely to be forgotten
- **The `instructions` orientation prose never mentioned solids**, exactly as it
  once said "You cannot see the video" under `preview_frames`. **Fixed
  structurally** rather than patched a third time — and looking for the general
  case found a live instance the run had missed: the COST paragraph claimed
  "the two capabilities" cost credits when six did. The node list is now a
  `Record` keyed by `EuclidNode['type']` (adding a node type fails the build
  until it is described), counts are derived from the catalog, and every
  capability named in prose goes through a `ref()` that throws at module load.
  All three were verified to fail before being trusted

Most generated files still stop at the asset tree, and **3D is the exception**.
The document has no image or video node, so generated stills, clips and music
are files a project holds rather than things on the stage; a generated *model*
reaches the stage, because `import_mesh` reads its GLB into a mesh node. Images
and video belong to Phase 5, which wants the WebCodecs rework first — doing the
image half alone would put a display seam in the stage that the video work
would immediately have to rewrite.

The editor can now **look** at one, which is a different claim: the explorer
opens any asset inline (2026-08-17, plans/003) — image, video, audio, text, and
a structure read-out for a GLB. That is a file browser doing its job, not a
document node, and it deliberately stops short of the stage.

## Phase 5: General video → plans/003-general-video.md
Reinstated as the product direction 2026-08-15, and now sequenced after
animation depth (2026-08-16) rather than before it — the verification argument
that promoted it has been satisfied, and depth is the cheaper, more checkable
work. The direction is unchanged; only the order is.

This phase rides on the capture rework agent sight began: WebCodecs removes the
`page.screenshot()` round-trip, and asset proxies/thumbnails are the same
capability as a document contact sheet.
- [x] Replace per-frame screenshot capture with WebCodecs — **landed
      2026-08-19**. A real 32.6s narrated project renders in **45s instead of
      106s (2.35x)**, and the two outputs are equivalent: same 1957 video and
      1528 audio frames, same 32.616667s, PSNR 53.5 dB / SSIM 0.9995 between
      them. Screenshots remain as a fallback, chosen by asking the *page*
      whether `VideoEncoder` exists — it is a secure-context API, so that
      depends on how the render page is served rather than on which Chromium
      this is. `CAPTURE=png` forces it, which is the only way to exercise the
      fallback deliberately. Measured beforehand as ~1.6x on a synthetic
      document; a real one does better, because vector and LaTeX frames make
      larger PNGs and batching removes a round-trip per frame.
      **Spiked and measured 2026-08-19 — it is
      ~1.6x rather than the order of magnitude this plan assumed.** VP9 →
      IVF → ffmpeg produces a correct, visually lossless MP4 (PSNR 52.6 dB,
      SSIM 0.9984) at 32-34 fps on the host and 13 fps in the container,
      against 18.6 and 8.8 for screenshots, and moves 1.7 KB a frame instead
      of 75 KB. Compression turns out to be **free** — `encode()` measures
      0.0 ms and VP9/VP8 at every quality setting time identically — because
      the real cost is `new VideoFrame(canvas)`, the readback out of the WebGL
      canvas. Both paths are bottlenecked on pixel egress; WebCodecs halves it
      rather than removing it. Not yet wired into `render.ts`: the spike is
      committed, the premise changed, and landing it is a decision rather than
      a formality. Earlier measurement: `bench-capture.ts`
      splits the loop and finds the screenshot is **97-99%** of every frame in
      both the host and the Linux container, while rasterising a whole 1080p
      frame — 4,096-triangle solid included — costs 0.7-3.2ms. So plans/003's
      "unmeasured risk: WebGL under SwiftShader" is settled and is not a risk.
      It was also mis-framed: headless Chromium reports SwiftShader **on macOS
      too**, so there was never GPU acceleration to lose and the container is
      simply a uniformly slower CPU
- [x] Assets as first-class (registry) — done in Phase 2; the editor is a
      three-column workbench (explorer | canvas | scene) whose explorer opens
      any file inline (2026-08-17); proxies/thumbnails still to do
- [~] `video` / `audio` node types; tracks and layering within a scene —
      **audio done 2026-08-18** as document-level *tracks* rather than a node
      type (audio is never drawn, and a bed runs across cuts): `planAudio`
      feeds the timeline, the preview mixer and the ffmpeg mux from one
      function, the editor timeline became a lane editor with drag/trim/snap,
      and the agent got `add_audio_track` / `add_audio_clip` / `update_audio`.
      Verified in a real export by measured dB. Ducking under narration is the
      named gap. `video` still needs the WebCodecs rework first
- [x] Multi-track timeline UI — landed with the audio work (2026-08-18): a
      ruler, one scroller so no two lanes disagree about where a second is,
      zoom to 8x, clips that drag between lanes, trim from either edge, snap to
      cuts, and fades drawn as the ramps they are
- [ ] Ingest + analysis (fetch → transcode → STT → shot detection → segments)
- [ ] Decide the rights/ToS model **before** building the ingest fetcher
- [ ] Narration-anchored animation (sync to word timestamps)

## Phase 6: Real users — launch, and deliberately last
Moved to the end 2026-08-15. Auth, billing UI and a production deploy are
the work that only pays off once there is something worth signing up for,
and every hour spent on them is an hour not spent on the thing being sold.
Everything above is buildable against `DEV_ALLOW_ANON` and the internal
service key.

One consequence worth naming: plans/007 argues for agent sight partly
*because* this phase connects claude.ai over MCP OAuth, and that agent has
no shell. Deferring OAuth does not weaken the case — it means the shell-less
client arrives later, but the underlying problem is that looking at output
currently costs a 3-minute render and ~61 credits, which is true for an
agent holding a terminal too.

- [ ] MCP OAuth (workers-oauth-provider + Better Auth) — claude.ai connects
- [ ] Auth UI (sign up / sign in), remove DEV_ALLOW_ANON path from prod builds
- [~] Dashboard: project **list** done (`/` in the editor — agent-created
      projects were otherwise invisible, since the id only appears in a tool
      response). **Delete** done 2026-08-15 (`DELETE /api/projects/:id` with a
      full cascade — R2 bytes, rows, and the DO's document — plus a
      `delete_project` capability behind `confirm: true`); a create/delete
      **UI** and the credits page are still to do
- [ ] Deploy: workers, D1, R2, Containers; production secrets

## Parallel track: agent gateway → plans/008-mcp-gateway.md
Started 2026-08-15. Collapses the agent surface onto one implementation: a
capability catalog in the API worker behind three fixed MCP tools, so a new
verb costs one catalog entry instead of an endpoint plus a hand-written tool
plus a docs row — and a tool edit no longer needs a client restart.
- [x] Capability catalog in the API worker (25 entries) + shared services
- [x] Gateway endpoints: instructions / describe / execute (+ paid executor)
- [x] `apps/mcp` rewritten onto it: 807 lines → 295, five fixed tools
      (`instructions`, `describe`, `execute`, `execute_paid`, `ask_user`)
- [x] Re-run the milestone over the gateway — the feasibility gate. **Passed,
      run 4 (2026-08-16):** `instructions` called first unprompted, exactly
      **one** `describe` (batched, and for a question the summaries genuinely
      could not answer), and **zero failure loops** — 10 failed calls in 4
      distinct argument-shape mistakes, every one corrected on the next
      attempt from the error text alone. The generic executor is not costing
      reliability; the escape hatch stays unused. Two catalog *validation*
      bugs found — see plans/008.

## Parallel track: agent asks the human → plans/005-agent-questions.md
- [x] `ask_user` / `get_answer` / `record_answer`; questions ride the project
      DO and appear live in the editor, answerable there or relayed from chat

## Parallel track: desktop app → plans/004-desktop.md
Evaluated, deliberately not started. Everything that breaks on the server
(no H.264 encoder, no GPU, SwiftShader) is abundant on the desktop, and
local rendering inverts the cost model. Revisit when the general-video
direction is confirmed, container render cost becomes a constraint, or users
prove unwilling to upload source footage.

