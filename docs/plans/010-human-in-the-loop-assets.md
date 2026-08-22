# 010 — Human-in-the-loop assets (status: done, 2026-08-22)

The agent stops building alone. Today the workflow is agent-shaped end to
end: it plans silently, spends credits on generation silently, and places
assets into the document silently — the human's first look at anything is
often the finished render. This plan inverts the default: **the human
approves the plan before credits are spent, and reviews every generated
asset before it reaches the document.** Assets also stop being trapped in
the project that generated them: they become a per-user library that any of
the user's projects can reference.

Three requirements, one design:

1. **Planning is reviewable.** The agent proposes a plan (scenes, narration
   draft, assets to generate, estimated cost) and waits for approval before
   generating anything.
2. **Assets are reviewable.** A generated asset arrives as `pending`; the
   human approves, rejects, or requests changes — in the editor with the
   file in front of them, or in chat. Iterations form a visible lineage.
3. **Assets are shareable.** An approved asset belongs to the user, not the
   project, and can be placed in any of their projects.

## Design decisions

### Approval rides the decision mechanism, not a new one

plans/005 already built the hard half of human-in-the-loop: questions that
work headless (chat is the surface that always exists), two answer surfaces
with recorded provenance (`via: editor | agent`), first-answer-wins with a
409 for the second, and blocking-by-wording ("STOP — WAITING ON THE
HUMAN"). Building a second approval channel would duplicate all of it and
then drift.

So a review request **is a decision** — extended, not replaced. `Decision`
gains an optional `refs` field:

- `{plan: planId}` — "approve this plan" (options: approve / request
  changes, plus the free-text note that already exists)
- `{assets: [assetId, ...]}` — "review these assets"

The editor renders a decision with refs richly (plan outline, inline file
previews via the existing `FileViewer` components); chat renders the same
pasteable block it always has, with asset URLs the human can open.
Answering an asset decision is what writes the asset's review status — one
approval path, two surfaces, exactly the shape `record_answer` set.

**Elicitation splits by what the decision needs seen.** A plan approval is
textual and the agent has already presented the plan in conversation, so
`ask_user`'s elicitation path may carry it. An asset review is meaningless
without the file in front of the human — a client picker clicking "approve"
on something never looked at is exactly the failure this plan exists to
prevent. As built, this needed no flag at all: `request_review` is a
capability, not `ask_user`, so it never elicits by construction — it always
returns the block-with-URLs, and the editor renders the same decision with
the file inline.

### The plan is a DO object, like decisions — not part of EuclidDoc

A plan is workflow state: it never affects a frame, so it must not bump
`SCHEMA_VERSION` or reach the renderer — the same argument that kept
decisions out of the document. It lives in DO storage under `plan:<id>`,
broadcasts over the existing WebSocket, and survives disconnects, so a plan
proposed before the editor was open is waiting when it opens.

Shape (Zod in `packages/dsl/src/plan.ts`, beside `decisions.ts`):

```
{ id, revision, status: proposed | approved | changes_requested | superseded,
  summary, scenes: [{title, narration, beats}],
  assets: [{kind, prompt|source, model?, estCredits}],
  estTotalCredits, spentCredits, decisionId, createdAt }
```

A revised plan is a **new revision that supersedes the old**, never an
edit — the audit-trail argument assets already make. `estTotalCredits` is
computed server-side from the roster and render pricing, never typed by the
agent, so the number the human approves is the number the system would
charge.

**Approval is a budget, not a snapshot.** What the human authorizes at plan
time is spending — which assets get generated and roughly what it costs —
so that is what approval is scoped to: the plan's asset roster and its
credit estimate. Each gated `generate_*` draws down `spentCredits` against
`estTotalCredits`; the alternative — expiring approval when the project has
"drifted" — poses an unanswerable question ("how different is too
different?"), and this replaces it with arithmetic, the same move
`effectsPastEnd` and the estimate itself make. Two consequences worth
stating: approval never expires by *time*, because punishing a user who
walks away for a day is exactly the headless/async usage plans/005 fought
to protect; and document iteration — layout, animation, re-timing — never
re-triggers approval, because that work is free and the asset-review gate
still catches every output before it lands.

### Review mode is a hard gate, per project, default on

plans/005 deliberately left *asking* to the agent's judgement — hardcoded
triggers fire when unwanted and miss what nobody predicted. But the same
plan's first real run proved the converse for *waiting*: "a question that
doesn't stop the asker is a log line." Instructions prose alone cannot
guarantee the human stays in the loop; a gate can.

`review_mode` is a boolean on the project row, **default on**. While on:

- `execute_paid` refuses `generate_*` and `generate_narration` unless the
  project has an approved plan revision **with budget remaining for the
  call**: the generation must match an entry in the approved roster, and
  its cost must fit inside `estTotalCredits − spentCredits`. A generation
  outside the roster, or one that would overrun the budget, is refused
  naming `propose_plan` (a revision) as the remedy — the same
  teaching-by-error shape every other refusal uses.
- Placement capabilities (`add_image`, `add_video`, `import_mesh`,
  `add_audio_clip`) refuse an asset whose review status is not `approved`,
  naming `request_review`. Narration is the deliberate exception: its audio
  attaches on generation, because that is how it is auditioned and how real
  timings exist to choreograph against — the render net below is what holds
  an unapproved take out of the export.
- `render_video` refuses while the document references any unapproved
  asset — the last net, catching narration and anything that slipped
  through mode toggling.

While off, nothing changes from today. "At first" is the product intent:
new projects start gated; a user who trusts the loop turns it off from the
editor (`set_review_mode` capability + a toggle in the UI). The gate landed
one layer lower than first sketched — in **the services beside the debit**
(`startGeneration`, `generateSceneNarration`), not in the executor — because
that is where budget, credits and refunds already meet at one boundary with
one refund path, the same argument that put those services there at all.
Never in the MCP worker — one implementation surface, per plans/008.

User uploads are **auto-approved**: the human made or chose the file, so
routing it through their own review queue is ceremony. Provenance decides:
`internal` producers (TTS, fal) mint `pending`; the owning user's uploads
mint `approved`.

### Asset review state is D1 columns; iteration is lineage

Assets are immutable, so review state is the one mutable thing about a row
and it belongs beside the row: `review_status` (`pending | approved |
rejected`), `review_note`, `reviewed_at`, `reviewed_via` on `assets`.
Existing rows backfill to `approved` — they predate the gate, and turning
every old project red on migration day helps nobody.

Iteration needs no new object because immutability already gives it one:
`generate_*` gains an optional `revises: assetId`, stored as a `revises`
column. A lineage is a chain of rows; the review UI walks it to show v1 →
v2 → v3 side by side, and `list_assets` prints `rev of <id>` so the agent
can see the chain too. Rejecting an asset with a note is the iteration
signal — the note is the answer text of the review decision, which the
agent reads and regenerates against, `revises` pointing at the rejected
row. Rejected assets are kept, not deleted: the lineage *is* the record of
what the human turned down and why.

**Narration review is script review, not audio review.** Listening to
every take is the tedium; reading a script diff is fast. So approval
attaches to the *text*: the first take of a scene enters review normally,
and once its text is approved, regenerating that same approved text with
the same voice auto-approves — re-synthesis of approved text is not a new
creative decision. What re-enters review is an **agent-rewritten script**.
And a script the human edited themselves in the editor auto-approves its
audio outright — the provenance rule that already covers uploads, applied
consistently: the human's own content never queues for their own approval.
The escape hatch for "the voice itself is wrong" stays (any pending take
can be rejected), but it fires once per voice choice, not once per take.

### The library: user-owned assets, project links

Today `assets.project_id` is the owner — tenancy joins through `projects`,
R2 keys are `assets/<projectId>/<assetId>`, and project deletion cascades
the bytes. Sharing breaks that cleanly rather than bending it:

- `assets` gains `user_id` (backfilled by the join that used to run per
  request). Tenancy becomes `mayAccess(asset.user_id, caller)` directly —
  one join *removed* from the hot path.
- A `project_assets` link table (`project_id, asset_id, path`) records which
  projects reference an asset, and carries the per-project virtual `path`
  (the same file can be `/refs/logo.png` here and `/branding/logo.png`
  there). `assets.path` and `assets.project_id` remain during migration as
  the creating project's view, then `project_id` is dropped once the
  explorer reads links.
- New R2 keys are `assets/<userId>/<assetId>`; old keys stay valid because
  the key is stored per row — no byte migration, ever.
- `add_image` / `add_video` / `import_mesh` / `add_audio_clip` accept any
  asset **the user owns** (approved, in review mode) and auto-link it into
  the project so the explorer shows what the document uses. A document
  holding an `assetId` from another project is safe precisely because
  assets are immutable — the reference can never change meaning.
- `list_assets` gains `scope: project | library` (default `project`, so
  existing behaviour and result sizes are unchanged).

**Deletion changes meaning, and says so.** Deleting a project deletes its
links, then deletes only assets whose last link that was — an asset placed
in two projects survives the death of one. The bytes→rows ordering from
the delete cascade holds, with the link check before the R2 delete. The
dry-run report gains a line: "n assets also linked elsewhere will be kept."
Deleting from the *library* (`remove_asset`) refuses while any project
links the asset, listing the projects — the same shape as `delete_project`
refusing without `confirm`.

### The review UI

The editor already has the pieces: an explorer over `useAssets`, a
`FileViewer` that renders every kind, and decisions arriving live over the
WebSocket. The review UI composes them:

- **A review queue** (right panel, above the inspector — where
  `Decisions.tsx` sat before its 2026-08-15 unmounting; this is the feature
  that earns that space back). Pending plan and asset decisions, newest
  first, with a badge count. A plan renders as its scene/asset/cost
  outline; an asset decision renders the file inline — image on the
  checkerboard, audio player, video via its proxy, GLB structure readout.
- **Approve / Request changes** buttons write the decision answer (and
  through it the asset status) — `via: editor`. Request-changes requires a
  note, because a bare rejection gives the agent nothing to iterate on.
- **Lineage strip**: when an asset revises another, the queue shows old and
  new side by side. That comparison is the whole reason iteration review
  exists.
- **Explorer badges**: pending / rejected markers on files, and a library
  section (or scope toggle) showing the user's assets from other projects,
  draggable into this one (drag = link, not copy).
- Review-state changes reach open editors by a lightweight DO broadcast
  (`asset-reviewed`), reusing the socket that already carries ops and
  decisions — no new transport.

### What the instructions block teaches

The orientation prose gains the workflow: *propose a plan first; wait;
generate; request review; wait; iterate until approved; only then place and
compose.* Every capability named in it goes through `ref()` so the prose
cannot outlive the catalog (the three-times-stale lesson from plans/009).
The gates make the workflow true even when the prose is ignored; the prose
makes the agent good at it rather than merely compliant.

## Phases

### Phase 1: Plan proposal + review mode gate (status: done, 2026-08-22)
- [x] `packages/dsl/src/plan.ts` — plan shape, Zod, `formatPlan()` for cheap
      agent-facing text; `Decision.refs` added (additive, no SCHEMA_VERSION
      bump — decisions are DO state, not document)
- [x] DO: `plan:<id>` storage, `GET/POST /plans`, broadcast; approval via the
      existing decision answer path flips plan status. `/plans/spend` is the
      atomic check-and-draw (the DO serializes requests — op versioning's
      trick reused) and is reachable only via the service stub; the API
      forwards `/plans` read-only
- [x] `projects.review_mode` column (default 1); `set_review_mode` capability
      — the editor binds to the same capability over the gateway's
      `?format=json`, so no separate REST route exists to drift
- [x] Capabilities: `propose_plan` (server-computed credit estimate),
      `get_plan` — both free. `get_project` also banners the gate, so an
      agent that skipped orientation meets it before its first refused call
- [x] The gate: `generate_*` and `generate_narration` require an approved
      plan when review mode is on, the call matching the roster and fitting
      the remaining budget (`spentCredits` drawn down per call, refunded when
      the generation refunds — `generation_jobs.plan_id` routes a late
      refund); refusal names `propose_plan`. Landed in the services beside
      the debit rather than in `execute_paid` (see the design note above)
- [x] Instructions prose: the gated workflow, every capability through
      `ref()`
- [x] Verified by `check-review.ts` (see Phase 5 — the Phase 1 slice exists
      and passes: gate refusal, server pricing, editor-click approval,
      roster and budget refusals, drawdown + refund on failure,
      note-only → changes_requested with the prior budget standing, second
      answer 409, ungating. Net credit cost of a run: zero)

### Phase 2: Asset review lifecycle (status: done, 2026-08-22)
- [x] Migration: `review_status`, `review_note`, `reviewed_at`,
      `reviewed_via`, `revises`, `tts_hash` on `assets` (the default
      backfills existing rows to `approved`); `revises` on `generation_jobs`
- [x] Provenance sets the initial status: generated files → `pending` while
      review mode is on (judged at collect time); owner uploads and render
      outputs → `approved`
- [x] `request_review` capability (free): creates an asset-refs decision,
      returns the STOP-and-wait block with a link per file; answering it —
      either surface — writes the asset rows in the DO and broadcasts
      `asset-reviewed`. No `elicit` flag was needed: a capability never
      elicits by construction (see the design note above)
- [x] Narration auto-approval: re-synthesis of approved (voice, text) skips
      the queue via `tts_hash`; a human-authored script skips it via
      authorship — explicit text is attributed by which surface sent it, and
      document text by an event-log scan (`/narration-author`) that skips
      the `system` write-back. Unknown authorship reviews
- [x] `generate_*` accept `revises` (validated: in-project, same kind);
      narration links its lineage automatically, since the predecessor is
      the scene's current take. `list_assets` prints `[PENDING REVIEW]`,
      `[REJECTED: "note"]` and `rev of <id>`
- [x] Placement gates (`add_image`, `add_video`, `import_mesh`,
      `add_audio_clip`) and the `render_video` last-net over
      `assetIdsInDoc`, both active only in review mode; narration attaches
      on generation by design and is caught by the net
- [x] Verified by `check-review.ts` phase-2 sections: pending provenance,
      render refusal naming the file, placement refusals for pending and
      rejected, reject-with-note → regenerate → automatic lineage →
      approve → placement unlocks, both auto-approval rules, and the four
      takes metering the plan budget by exactly their cost

### Phase 3: Review UI (status: done, 2026-08-22)
- [x] Review queue panel (`Review.tsx`, superseding the unmounted
      `Decisions.tsx`): open decisions newest first with a badge count,
      rendered by their `refs` — plan, assets (inline previews reusing the
      `FileViewer` renderers, video via proxy), or plain question. Approve
      is one click; request-changes is disabled until the note says
      something. Sits above the inspector: a stalled agent outranks a
      property sheet
- [x] Plan renderer: scenes with narration drafts and beats, the priced
      asset roster, budget with remaining, approve / request changes
- [x] Lineage strip: previous take (with its rejection note) beside the new
      one whenever `revises` is set
- [x] Explorer dots for pending / rejected (approved earns nothing);
      review-mode toggle in the header, bound to the `get_plan` /
      `set_review_mode` capabilities over the gateway's `?format=json` — no
      second REST surface to drift. `useProject` handles the `plan` and
      `asset-reviewed` broadcasts; the latter bumps a counter that keys the
      file list's refetch
- [x] Verified in the browser on a staged project (approved plan rev 1, a
      rejected take, its pending revision, an open plan rev 2): queue and
      lineage render, zero console errors; clicking approve dropped the
      badge 2 → 1, greyed the decision `via editor`, and cleared the
      explorer's pending dot live off the `asset-reviewed` broadcast; the
      header toggle round-trips review mode through the gateway

### Phase 4: The library — cross-project assets (status: done, 2026-08-22)
- [x] Migration: `assets.user_id` backfilled via the projects join;
      `project_assets` link table (with per-project `path`) populated from
      existing rows; new R2 keys under `assets/<userId>/…` (old keys
      untouched — the key is stored per row, so no byte ever moved). The
      owner is the **project's owner**, not the storing caller: an internal
      producer stores on the owner's behalf
- [x] Tenancy: asset gates check `user_id` directly (the projects join
      survives only as a COALESCE fallback for pre-migration rows, and keeps
      an asset servable after its home project dies); `serveR2Range`
      unchanged
- [x] Placement capabilities accept any owned+approved asset and auto-link
      (`ensureLinked` — the ownership check lives in the link, which also
      refuses joining one user's file to another user's project even for
      internal callers); `list_assets` gains `scope: library`, marked with
      link counts; `link_asset` stages without placing, `unlink_asset` takes
      a file out of one project without touching bytes
- [x] Delete semantics: project delete reaps only the **doomed set** — last
      link here, plus legacy rows linked nowhere, one query so a legacy sweep
      cannot orphan bytes — and the report counts what will be kept.
      `remove_asset` refuses (no force) while other projects link it, naming
      them; `unlink_asset` refuses while the document references it
- [x] Editor: library section in the explorer listing the user's assets from
      other projects, one ⊕ from linking in — **click-to-link rather than
      the drag this plan sketched**: a narrow panel makes a button clearer
      than a drop zone, and the semantic (link, never copy) is the point
- [~] Drop `assets.project_id` — **deliberately deferred**, as this plan
      allowed. It still serves as the home project for: the legacy delete
      sweep, `moveAsset`'s default view, render-output registration, the
      proxy key prefix, and generation bookkeeping. Each is a small
      mechanical change; none blocks the library, and dropping the column
      before they move would break them silently

Verified by `check-library.ts` at zero credits (uploads only), and
`check-review.ts` re-run green over the reworked asset layer — the phases 1–2
lifecycle carries unchanged. The editor half verified live: the library
section lists other projects' files and a ⊕ click linked one in, moving it
into this project's tree.

### Phase 5: Verification + milestone (status: done, 2026-08-22)
- [x] `check-review.ts` covers phases 1 and 2 end to end (landed with each
      phase): the plan gate suite, and the asset lifecycle — pending →
      render/placement refusals → rejected with note → regeneration with
      automatic lineage → approved → placed, plus both narration
      auto-approval rules and budget metering. Total cost of a run: 4
      credits (four real narration takes); every fal path is free by
      construction
- [x] `check-library.ts` (landed with phase 4, zero credits): upload owned
      and home-linked → library scope sees it from another project → link
      under a per-project path (idempotent) → placement into a third project
      auto-links → foreign user refused read and link → per-project rename
      leaves other views alone → home project deleted, file and bytes
      survive and the report counts them → delete refused naming the linking
      project → unlink refused while the document references it → node
      removed, unlink lands → last-link delete finally removes the bytes
- [x] **Milestone run 8 (2026-08-22): "Why the moon has phases"** — 19.3s,
      1080p, narrated, rendered in 60s, delivered. The first milestone with a
      **real human in the loop**: the plan (12 credits, server-priced) was
      approved by the human in chat and recorded `via agent`; the four
      generated assets (one starfield, three narration takes) landed pending
      and were approved through `request_review`; the render waited for
      explicit human approval twice (the first ask was declined with
      change requests). Findings, most important first:
      **(a) The loop paid for itself before the render.** The human's review
      of the first preview caught three composition errors the agent had
      passed: no starfield beyond scene 1, the moon visibly off its orbit
      ring, and a sunlight cue that neither looked right nor touched the
      planet. All were fixed in free preview rounds; the render was queued
      once and succeeded once. Total spend: 9 credits of generation + 20 of
      render, none wasted. Round-trips: 1 plan approval, 2 asset reviews,
      4 preview iterations with feedback, 1 render approval.
      **(b) The human sees surfaces the agent structurally cannot.** Watching
      the editor canvas exposed that it had never drawn an image at all (the
      Pixi blob-URL defect above) — invisible to `preview_frames`, which
      looks through the render path that worked.
      **(c) A flat `path` and a vertex-projected mesh disagree under camera
      yaw** — the off-orbit moon. A path projects as a node at its anchor
      while a mesh projects per vertex, so a follower and its track part
      company as yaw grows. Worked around by flattening the scene's camera;
      the real fix would be projecting path points per-vertex like the
      spatial nodes, noted as future work.
      **(d) A tracking shadow needs no new machinery when the occluder rides
      a path**: ride the *same* path with the *same* flow clock and the
      shadow is glued to its occluder by construction — how the beam
      occlusion was built from two wedge paths and an opacity envelope.
      **(e) Errors-as-documentation carried the whole build**: five argument
      mistakes (`narrationText`, `textContent`/`fill`, relative `x2`/`y2`,
      `at` not `times`, `strokeWidth > 0`), every one corrected on the next
      call from the error text alone.
- [x] Docs: architecture.md (review lifecycle, library ownership),
      mcp-tools.md (new capabilities, gates), this plan's markers — kept
      current with each phase rather than batched here

## Questions, resolved (2026-08-22)

Four were open at proposal; all four are now decided, and the first three
share one principle: **replace judgement gates with mechanical ones.**
Gates that require judgement get argued with or ignored; gates that are
arithmetic just fire.

- **Does plan approval expire? → No; approval is a budget** (folded into
  the plan-shape section above). Roster + credit estimate, drawn down per
  generation, refusal on overrun. Never by time, never by document drift.
- **Narration cadence → review the script text, not the audio bytes**
  (folded into the asset-review section). Text equality against approved
  text decides; human-authored edits auto-approve by provenance.
- **Elicitation → split by what the decision needs seen** (folded into the
  decision section). Plans may elicit; asset reviews never do.
- **Sharing beyond one user (teams) stays out.** Projects are single-user
  in v1 and the library inherits that. The `user_id` column is precisely
  the seam a team model would extend — owner becomes an org id,
  `mayAccess` grows a membership check — so deferral forecloses nothing
  and costs nothing now.

## Notes / gotchas

- **The drawdown is the last thing before the provider sees the request.**
  Every check with no side effects (balance, model, roster) runs first, so a
  refusal costs nothing; once the budget is drawn, everything after refunds
  it on failure — submit failure inline, later failures via
  `generation_jobs.plan_id` during the poll that discovers them. Putting the
  gate *before* the balance check would read better ("the plan is the outer
  gate") but would draw down budget for a call that then fails on credits,
  adding a second refund path for no behavioural gain.
- **A refund to a superseded plan is skipped, not applied.** The plan that
  replaced it never counted that spend, so returning budget there would
  inflate a number nothing meters. The user's *credits* still refund in
  full — that is the half that matters.
- **`assert.equal(res.status, 200, await res.text())` eats the body.** The
  message argument evaluates even when the assertion passes, so the next
  `res.json()` throws "Body is unusable". Read the body once into a
  variable. (Cost one check-run to find; recorded so it doesn't cost two.)
- **A generation's review status is judged at collect time, not submit
  time.** A slow job submitted under review mode and collected after the
  human turned it off lands `approved`, and vice versa. Deliberate: the
  status describes what should happen to the file *now that it exists*, and
  the toggle's current position is the human's current answer to that.
- **The DO writes the asset rows itself** (`applyAssetReviewAnswer`). Two
  paths answer decisions — the editor's forwarded click and
  `record_answer` — and both land in the DO, so putting the consequence
  anywhere else would mean implementing it twice or forgetting one path.
  Same argument that put the plan flip there.
- **The project-delete doomed set must cover legacy rows in the same query
  that collects R2 keys.** The first draft swept pre-link-table rows in a
  second DELETE after the keys were gathered — which would have orphaned
  their bytes forever, the exact failure the bytes→rows ordering exists to
  prevent. One query: (last link here OR home-here-with-no-links) and not
  linked elsewhere.
- The `assert.equal(…, await res.text())` body-eater bit a second time,
  in check-library. The note above did not prevent it; a tiny
  `readOnce(res)` helper in the next check script probably will.
- **Run 8 finding: the editor canvas had never drawn an image.** The image
  seam has two halves, and only the export half was ever verified
  (`check-image`) — the editor's `sessionImageProvider` pushed a `blob:` URL
  through Pixi's `Assets.load`, which picks its parser from the URL's file
  extension, and a blob URL has none. It warned "we don't know how to parse
  it" and drew nothing, while `preview_frames` and the export showed the
  picture — so the *human's* surface was the broken one, found the first
  time a human watched the canvas during a review. Fixed by decoding the
  blob (`createImageBitmap`) and handing Pixi pixels, as the video provider
  beside it already did. The general lesson is the seam lesson again: when
  one capability is deliberately answered two ways, each answer needs its
  own verification — the seam is exactly where "verified" on one side reads
  as verified on both.
