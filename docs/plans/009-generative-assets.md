# 009 — Generative assets and mesh solids (status: in progress)

Two pieces of work that arrived together on 2026-08-17 and turn out to be
related only at the end: **fal as a generative asset provider**, and **real
mesh solids in the renderer**. The connection is 3D — fal can generate a 3D
model, and the obvious question was whether we could draw one. The answer is
partly yes, and the plan is careful about which part.

Sequenced ahead of general video (plans/003) at the user's request, and it
earns the place: assets-as-first-class is 003's §1, and every generated file
lands in the registry that phase already built.

## Phase A: can we correctly render a 3D mesh? (status: done)

The question was asked as a feasibility check, so it was answered as one —
before any production code.

Everything three-dimensional in the engine today is `project3`: points
projected to the z=0 plane with depth cues, no GPU, no z-buffer. That is
deliberate (plans/006 Phase C, and Cloudflare Containers have no GPU). A mesh
extends it to *triangles*, which raises exactly one real question: **is
per-face painter's-algorithm sorting correct?** It is famously not, in general.

### The probe, and its numbers

Rather than eyeball a render, the same mesh was rasterised twice from identical
projected geometry with identical shading — once with per-face painter sorting
(what we would ship) and once with a per-pixel **z-buffer** (ground truth) —
and the differing pixels counted. Depth was interpolated as 1/w linearly in
screen space, which is exact under perspective, so the ground truth is a real
one. Four camera angles each, 640×480:

| Mesh | Triangles drawn | Wrong pixels | Visibly wrong |
|---|---|---|---|
| cube (culled) | 6 | 0.00% | 0.00% |
| sphere, 1536 tri (culled) | 867 | 0.00% | 0.00% |
| **torus, 2304 tri (culled)** | 1222 | **0.00%** | **0.00%** |
| torus, no culling | 2304 | 0.01% | 0.01% |
| two interpenetrating quads | 4 | **11.12%** | 11.12% |

Three conclusions, and they decided the design:

1. **Backface culling is a correctness feature, not an optimisation.** With it
   on, painter's ordering is *exactly* right — zero differing pixels — even on
   a torus, which occludes itself. Culling removes the inward-facing half, and
   what remains of a closed surface can always be depth-ordered. Without it the
   same torus is merely close (0.01%).
2. **Interpenetration is the real limit**, and no flag fixes it: sorting whole
   triangles cannot interleave two surfaces that pass through each other. It is
   named in `add_mesh`'s doc rather than hidden.
3. **No GPU and no z-buffer are needed**, so a mesh stays pure arithmetic on
   (document, time) and slots into the existing sampler. The purity invariant
   survives.

### What landed

- `packages/dsl/src/mesh.ts` — `MeshGeometry` as a **spec**, not a vertex list:
  `{kind:'sphere', radius, segments}` expands to triangles at draw time via the
  pure `buildMesh`. A default sphere is 576 triangles; storing those in the
  document would push ~100KB through the event log on every op, and an agent
  cannot type them. `custom` is the escape hatch an import would use.
- `MeshNode` in the document, `mesh` in the stage's spatial path, `add_mesh` in
  the catalog with six parametric shapes.
- `LIMITS.maxTriangles = 4000`, checked by arithmetic *before* the mesh is
  built, so an expensive shape is refused rather than allocated.
- Shading is flat Lambert against a **fixed** light. Fixed on purpose: it is a
  depth cue, and a scene where every solid agrees where the light is reads as
  one space. Depth dims the *shade*, not the alpha — a solid fading toward
  transparent reads as glass.

### Verified — `check-mesh.ts`

A **winding invariant** runs first and needs no renderer: for a convex solid
centred on the origin, every face must satisfy `n · centroid > 0`. It is the
only check here that can see an inside-out solid — see run 7 below — and it
covers cube, sphere, cylinder and cone at once. Then integration in pixels,
since the probe already settled the ordering maths:

- **A solid is solid**: a bright disc reads 13.71% lit, and 0.00% with a
  background-coloured sphere in front of it. The sphere is invisible against
  the backdrop, so the only thing being measured is what covered what.
- **Shading is per face**: the same sphere reads 18.01% unshaded and 15.78%
  flat-shaded, because the faces turned from the light fall under the
  threshold. Equal readings would mean one colour everywhere.
- **Culling changes nothing on a closed solid** — 0.00% apart. That is the
  visible consequence of the sort being right: back faces are covered either
  way.
- **Placement**: framed on a cube at 8×, 100.00% lit; 640px to the side,
  0.00%. Ink cannot see *where*, so the camera is what proves it.
- **A pitch orbit changes the picture**: 12.75% → 22.88% as a torus goes from
  edge-on to face-on.
- **write_on builds face by face**: 1.27% → 6.39% → 17.95%.

#### Notes / gotchas

- **A yaw orbit cannot test a torus.** The first draft of the orbit test used
  `orbit_camera` (yaw) and read 10.62% at all four angles. That is *correct* —
  the generated ring lies in the xz plane, so it is rotationally symmetric
  about the vertical axis. The test was wrong, not the renderer. It now
  animates **pitch**, where the silhouette genuinely changes.
- Sampling a `write_on` past its own duration reads as a plateau, not a build.
  Both draft failures were bad tests; neither was a code defect.

## Phase B: fal as a generative asset provider (status: in progress)

### Shape

`apps/api/src/fal.ts` mirrors `tts.ts` — a provider seam written against web
standards only, no Cloudflare types. What differs is that TTS answers in one
call and generation does not, so the unit is a **submitted request**.

**The queue is fal's, not ours.** A request sits in `queue.fal.run` until it is
collected, so `generation_jobs` is bookkeeping — which project asked, what it
cost, what it became — rather than a work queue needing a worker. This is why
the phase adds no second process, unlike renders.

One consequence, named in the tool doc: `get_generation_status` is what
*advances* a job. There is nothing in the background; asking is collecting.

### Decisions taken

- **Submit before debiting.** A request fal rejects outright (no prompt, no
  image) must cost nothing, and the provider is the only thing that knows.
  Everything after the debit refunds on failure, including a failure discovered
  minutes later during a poll.
- **One code path for fast and slow models.** `startGeneration` waits inline up
  to 20s and then degrades to returning a job id. An image lands in ~3s and
  making the agent poll for that would be a worse tool; a video takes minutes
  and no request can hold that.
- **The queue URLs fal returns are used verbatim**, never rebuilt from the
  model id. An endpoint with a sub-path (`fal-ai/flux/schnell`) is polled at
  the *app* path (`fal-ai/flux/requests/...`), so constructing them ourselves
  would be wrong for exactly the models most likely to be used.
- **A roster entry is the unit of extension.** Adding a model is one entry plus
  a price; the capability layer is generic over kind, so a new model costs no
  new tool, no new route and no client restart — the gateway's whole argument.
- `assets.kind` gains `model` for GLB files.

### The roster

Every id below was confirmed live against fal (a wrong id 404s; these did not).
Prices are what we charge, not what fal charges — the margin covers refunds.

**Every model is verified end to end** as of 2026-08-17 — each one submitted
through our own stack, collected, and the stored bytes identified by **magic
number** rather than by the mime anyone claimed. `check-fal-roster.ts` is the
script; it cost about $0.50 to run, most of it kling.

| Kind | Model | Credits | Took | Produced |
|---|---|---|---|---|
| image | `flux-schnell` | 2 | ~3s | 59KB jpeg |
| image | `flux-dev` | 6 | 9s | 99KB jpeg |
| image | `flux-pro` | 12 | 8s | 268KB jpeg |
| video | `ltx-video` | 25 | 100s | 452KB mp4, h264 768×512, 5.04s |
| video | `kling-video` | 60 | **313s** | 4.9MB mp4, h264 1280×720, 5.10s |
| audio | `stable-audio` | 10 | 69s | 1.7MB wav, 44.1kHz stereo, **exactly 10.0s** |
| model | `trellis` | 15 | 44s | 1.2MB glb, **10,236 triangles** |
| model | `hunyuan3d` | 20 | 161s | 7.7MB glb, **329,128 triangles** |

Both GLBs parse as structurally valid glTF 2.0 — declared length matching
actual, JSON + BIN chunks intact. `stable-audio` returning exactly the
requested 10.0s also confirms the roster's *input* builder, not just its
output reader.

`kling-video` at 313s is worth remembering: it is five minutes, so it is the
model that most needs the pending/poll path to work, and it does.

#### Gotcha: a provider saying "bytes" is not saying anything

Both image-to-3D models report `content_type: application/octet-stream` for
files that are provably glTF. Trusting that stored every generated model under
a mime that tells nobody anything, and left `extensionFor`'s
`model/gltf-binary` entry permanently unreachable. `fileOut` now treats the
generic octet-stream mimes as *absent* and falls back to what the roster entry
asked for — re-verified on a second trellis run, which now stores
`model/gltf-binary`.

#### Gotcha: fal's queue accepts before it validates

The roster ids were probed by submitting an empty payload, expecting 422 for a
real model and 404 for a fake one. **fal returned 200 for every real model** —
it enqueues first and validates in the runner, so eleven real jobs were
created. All eleven then failed validation (`422 Field required: prompt`) and
none ran an inference, so nothing was charged. The lesson is worth keeping:
*submitting to fal is not free of consequence even with an invalid body*, and
`submit()` therefore validates what it can locally before the call.

### Verified — `check-fal.ts`

Spends a few tenths of a cent (one flux-schnell image); the failure path is
built on a request fal rejects, so it costs nothing.

- A real 59KB `image/jpeg` arrived, checked down to its **magic bytes** — a
  JSON error page served with an image mime would pass every other assertion —
  and filed at `/images/sphere.jpg` in the project tree.
- Credits debited exactly once: 558 → 556 for a 2-credit call.
- A rejected 3D request **failed and refunded in full**: 556 → 556.
- **Polling is idempotent**: two extra `get_generation_status` calls moved
  neither the balance nor the file count.
- Unknown model, missing image, and the "the engine cannot draw a GLB" doc are
  all refused or stated plainly.

**The slow path was verified separately**, because an image never exercises it:
an `ltx-video` generation returned `pending` after the 21s inline wait, was
collected by `get_generation_status` at +100s, and landed at
`/videos/<prompt-slug>.mp4`. `ffprobe` confirms a real 452KB h264 file,
768×512, 121 frames, 5.04s — so submit → poll → collect → store works for a
large binary and not only for a small one.

### Deliberately not done

- **Nothing displays a generated file.** There is no `image` or `video` node in
  the document, so a generation lives in the project filesystem and not in a
  frame. Adding an image node is small and tempting; adding a *video* node is
  plans/003 §4 and wants WebCodecs first. Doing the image half alone would put
  a display seam in the stage that the video work then has to rewrite, so both
  wait for 003.
- **GLB import.** `add_mesh` covers parametric solids; importing a mesh is its
  own piece of work and is not this one. The roster run did, however, replace
  a guess with a measurement, and it is more encouraging than expected:

  | Model | Triangles | Over the 4,000 ceiling |
  |---|---|---|
  | `trellis` | 10,236 | **2.6×** |
  | `hunyuan3d` | 329,128 | 82× |

  This plan previously estimated "50k–200k" for both, which was wrong in the
  direction that matters. **A trellis output is within reach of a modest
  decimation pass** — roughly 4:1 — where hunyuan3d is not. Neither file was
  Draco-compressed: both are plain glTF 2.0 with intact JSON and BIN chunks, so
  a reader needs no decompressor, only a parser. That makes "put a generated
  object in a video" a substantially smaller job than it looked, and it should
  be scoped off `trellis` rather than off the worst case.

## Milestone run 7 (2026-08-17) — did the mesh work earn its place?

A 32.6s narrated explainer of Archimedes' sphere-in-a-cylinder result, built
over the gateway: four scenes, three of the six mesh shapes, an orbiting camera,
LaTeX write-ons, ElevenLabs narration, rendered to MP4. 7 credits of narration,
33 of render.

**Verdict: yes, and it found three defects the check scripts could not.** Nothing
was hand-rolled — the solids, the orbit and the reveals are all primitives — and
the run cost four `preview_frames` calls, one of which changed the video.

### 1. The cylinder was inside out, and no pixel count could see it

The first frame of the three solids showed the cylinder as an **open cup**: no
top cap, the interior floor visible. Every one of its 64 faces was wound inward,
so culling kept the far wall and dropped the near one.

What makes this the run's most valuable finding is *why* `check-mesh.ts` missed
it. An inverted solid has the **same silhouette** as a correct one — the lit
fraction was `0.14787` culled and `0.14787` unculled, identical to five decimal
places. Test 3 ("culling changes nothing on a closed solid") was the right idea
and it passed, because it was only ever run against a *sphere*. Cylinder and cone
caps had no coverage at all.

The remedy is not another pixel test. `check-mesh.ts` gained a **winding
invariant** that runs first, is pure, and needs no renderer: for a convex solid
centred on the origin, every face must satisfy `n · centroid > 0`. It reports
`cylinder: 64 of 64 faces are wound inward`, and re-introducing the bug was
confirmed to fail it. Degenerate triangles (the sphere's poles) are tangent and
skipped rather than failed.

### 2. A shape could be born unfilled but never made unfilled

`add_shape` documents `fill: "none"` for an outline, and implements it by
*omitting* the key. `update_node` rejected the same word — the patch goes
straight to `NodeSchema`, where `fill` is a strict `#rrggbb`. So the tombstone
diagram came out as a filled blue square, and the natural repair was refused.

The reducer had supported removal all along (`if (v === null) delete merged[k]`);
it was simply undiscoverable, and the two surfaces disagreed on the spelling.
`update_node` now accepts `"none"` as well as `null` and says so in its doc.
Milestone run 3's `update_node` trap was the same shape: a repair that reports
something other than what the caller meant.

### 3. The outline could not tell a sphere from a cone

`get_project` printed three solids as `mesh mesh_31202368 @(480,540,z=0)` — no
shape, no size. This is exactly run 6's arrow finding ("the outline never said
what an arrow connected") recurring for a new node type, which suggests the
outline is where a new primitive is most likely to be forgotten. It now prints
`cone r=180 h=360 80tri`, so the triangle budget is visible in the same glance.

### 4. The orientation prose did not mention solids

`instructions` listed `add_mesh` in its capability list but the hand-written
ORIENTATION paragraph above still said "vector3/axes3d/points3 for space". A
fresh agent reading orientation would not know solids existed. Run 6 fixed the
same class of staleness ("You cannot see the video" printed two lines under
`preview_frames`) — **nothing links the prose to the catalog**, so it goes stale
every time a primitive lands.

**Fixed structurally, 2026-08-17**, rather than by patching the sentence a third
time. Looking for the general case immediately turned up a *live* instance the
run had not noticed: the COST paragraph still said "everything is free except
**the two** capabilities" when six were paid. Three mechanisms now, one per kind
of claim:

- **Which node types exist** — `NODE_BLURBS` is a `Record<EuclidNode['type'],
  …>`, so adding a member to the union fails the build until it is described.
  Confirmed by deleting the `mesh` entry: `Property 'mesh' is missing … but
  required in type Record<…>`.
- **Counts** — derived from the catalog (`paid.length`), never typed.
- **Capability names in prose** — wrapped in `ref()`, which throws at module
  load. Confirmed by renaming one reference: the worker refuses to boot with
  `instructions reference unknown capability "…" — rename it here too, or the
  orientation block teaches a tool that does not exist`.

Both were verified to *fail* before being trusted, the same discipline the
winding invariant needed. `check-gateway.ts` also asserts the prose count
matches the catalog, so a future hardcode is caught even if the derivation is
removed. It was itself stale in the same way — it asserted "exactly the two
credit-spending capabilities" — and is now correct.

### What went right

- `add_mesh` needed no `describe` call; the summary was enough.
- Wrong argument names (`text` for `textContent`) were corrected on the next
  attempt from the error text alone, as in run 4.
- `fit_scene_to_narration` took the project from 51s of guessed durations to
  32.6s with 12% silence, in four free calls.
- The winding bug was visible in the **first** contact sheet, before a single
  credit was spent on narration or rendering.

## Phase C: GLB import — a generated model becomes a solid (status: done)

Closed 2026-08-18. Until this landed the phase ended in a contradiction:
`generate_3d` produced a file nothing could draw, and `add_mesh` drew only
shapes named by a formula. Import is the seam, and the `custom` geometry
variant existed from the start for exactly this.

It was scoped off **measurements, not the worst case** — the roster run had
already established that trellis returns ~10–19k triangles with no Draco
compression, so this is a parser and a simplifier rather than a decompressor.

### What landed

- `packages/dsl/src/glb.ts` — a glTF 2.0 / GLB reader against `DataView` only,
  no dependencies, so it runs inside the API worker. Deliberately partial: it
  reads **positions, indices and node transforms** and skips materials,
  textures, normals, UVs, skins and animation, because the renderer flat-shades
  from winding and has nowhere to put the rest. Draco is refused **by name**
  rather than silently yielding an empty mesh.
- `decimateMesh` — vertex clustering, chosen over quadric edge collapse because
  it is O(n), deterministic, and cannot fail on the loose shells, duplicated
  vertices and non-manifold edges a generated model actually has. Grid
  resolution is found by binary search, since the face count for a given
  resolution depends on the shape.
- `normalizeMesh` — centres, scales to a pixel size, converts glTF's **Y-up**
  to this system's **Y-down**, and rounds coordinates to whole pixels.
- `orientOutward` — see below.
- `import_mesh` in the catalog: asset id in, mesh node out.

### The two things an importer gets wrong quietly

**1. Orientation.** Negating an axis to convert Y-up to Y-down *reverses
orientation*, so every face ends up wound inward and culling keeps the far
surface — the model renders as a hollow shell with an **identical silhouette**.
That is the cylinder bug from milestone run 7, arriving by a different route.

The fix measures instead of assuming. Every generator in `mesh.ts` produces a
**positive signed volume** (verified: a cube of side 100 gives exactly
1,000,000), so positive means "wound outward" in this system. `orientOutward`
computes the signed volume and reverses the mesh if it is negative — and unlike
an `n · centroid` test it works on a shape that is not convex, which an
imported model never is. It runs *after* normalisation, because that is where
the reflection happens.

**2. The document budget, which is not the render budget.** Imported geometry
is stored in the document; the document lives under a single Durable Object
key; DO values cap at **128 KiB**. Measured:

| Target triangles | Geometry in the document |
|---|---|
| 1,500 | ~36 KB |
| 4,000 | ~103–107 KB |

So a mesh at the 4,000-triangle *render* ceiling would consume the entire
document on its own. `LIMITS.maxImportedTriangles` is **2,000** for that reason
alone, and `import_mesh` projects the resulting document size and refuses with
a number and a remedy rather than letting the write fail inside the DO.

### Verified — `check-glb.ts`

Spends ~17 credits (a seed image and one trellis generation).

- **An inside-out mesh is detected and repaired**: a cube from the trusted
  generator with every face reversed goes from volume −8,000,000 to
  +8,000,000, and the repair is idempotent. The fixture is *derived* from
  `buildMesh` rather than hand-written — the first draft hand-typed the indices
  and got the winding wrong, so the test asserted something false.
- **A real generated model imports**: trellis output, 10,132 → 1,382
  triangles, drawn as a recognisable owl statuette.
- **Culled and unculled agree to 0.00%** — the same property `check-mesh` uses
  for authored solids, and the assertion that would catch a bad Y-flip, since a
  hollow shell looks completely different with culling off.
- A non-GLB is refused by magic number; importing an *image* as a mesh names
  what the asset actually is; the document-budget refusal names
  `targetTriangles`.

## Still open

- GIF: no roster entry. The category is served by video models whose output is
  mp4; a real GIF path means an ffmpeg transcode, which the render container
  already has.
- **Hunyuan3d imports are coarse.** Its 329k triangles decimate to the same
  ~1,400 as trellis's 10k, so far more detail is thrown away. Trellis is the
  better source for import; hunyuan3d is the better file to hand to another
  tool. Worth saying in `generate_3d`'s doc once there is evidence it matters.
- **Vertex clustering does not preserve silhouettes** the way quadric edge
  collapse would. Fine at the size a solid occupies in a frame; revisit if a
  model ever needs to fill it.
- `upload_asset` is still missing (plans/003 §1), so a user cannot hand an
  image to `generate_3d` from their own machine — only a public URL works.
