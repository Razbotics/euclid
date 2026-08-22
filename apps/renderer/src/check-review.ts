/**
 * The human-in-the-loop gate (plans/010, phase 1), end to end.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-review.ts
 *
 * Needs `dev:api` with FAL_KEY and ELEVENLABS_API_KEY set, and a dev-user
 * balance ≥ 20 credits. Spends **4 credits** (four one-credit narration
 * takes — the cheapest honest way to mint assets whose provenance differs);
 * every fal generation is either refused by the gate before the provider
 * sees it, or is the check-fal trick — a submission fal's runner rejects —
 * so the whole drawdown → refund path runs without an inference billed.
 *
 * What is proved, in order: a project is born gated; paid generation is
 * refused until a plan is approved, with the refusal naming propose_plan; the
 * editor's answer click approves the plan through the decision path; the gate
 * enforces the roster (kind_not_in_plan) and the budget (budget_exhausted) by
 * arithmetic; a failed generation returns its budget to the plan it drew
 * from; a note-only answer is changes_requested and leaves the approved
 * budget standing; a second answer is refused; and review mode off restores
 * the ungated behaviour.
 */
import './load-env'
import assert from 'node:assert'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }

const run = async (name: string, args: Record<string, unknown>, paid = false) => {
  const res = await fetch(
    `${API}/api/agent/tools/${name}/execute?format=json${paid ? '&paid=1' : ''}`,
    { method: 'POST', headers: H, body: JSON.stringify(args) },
  )
  return { status: res.status, body: await res.text() }
}
const ok = async (name: string, args: Record<string, unknown>, paid = false) => {
  const r = await run(name, args, paid)
  assert.equal(r.status, 200, `${name} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any }
}
const refused = async (name: string, args: Record<string, unknown>, why: RegExp) => {
  const r = await run(name, args, true)
  assert.equal(r.status, 403, `${name} should be refused by the gate, got ${r.status}: ${r.body}`)
  assert.match(r.body, why, `the refusal must teach the remedy: ${r.body}`)
  return r.body
}
const balance = async (): Promise<number> => {
  const res = await fetch(`${API}/api/billing/balance`, { headers: H })
  return ((await res.json()) as { balance: number }).balance
}
const answer = async (projectId: string, decisionId: string, body: Record<string, unknown>) =>
  fetch(`${API}/api/projects/${projectId}/decisions/${decisionId}/answer`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ via: 'editor', ...body }),
  })

const startBalance = await balance()
assert.ok(
  startBalance >= 20,
  `this check needs ≥ 20 credits on dev-user for the drawdown and four TTS takes (have ${startBalance})`,
)

const proj = await ok('create_project', { name: 'check-review' })
const projectId = proj.data.id as string

// ---------- 1. born gated: no plan means no paid generation ----------
const plan0 = await ok('get_plan', { projectId })
assert.match(plan0.text, /review mode ON/, plan0.text)
assert.match(plan0.text, /no plan yet/, plan0.text)
const outline = await ok('get_project', { projectId })
assert.match(outline.text, /review mode ON/, 'get_project must surface the gate too')

await refused(
  'generate_image',
  { projectId, prompt: 'a red sphere' },
  /propose_plan/,
)

// ---------- 2. propose: server-priced budget, STOP block, linked decision ----------
const proposed = await ok('propose_plan', {
  projectId,
  summary: 'A short circle explainer',
  scenes: [
    { title: 'Intro', narration: 'A circle is every point at one distance.', beats: 'circle writes on' },
  ],
  assets: [{ kind: 'model', description: 'a statue to orbit', model: 'trellis', count: 1 }],
  narrationTakes: 1,
})
assert.match(proposed.text, /STOP — WAITING ON THE HUMAN/, proposed.text)
const plan = proposed.data.plan
const decisionId = proposed.data.decisionId as string
assert.equal(plan.status, 'proposed')
// trellis is 15 credits; the one-take narration estimate of this short draft is 1.
assert.equal(plan.estTotalCredits, 16, `server-priced budget: ${JSON.stringify(plan)}`)

// Proposed is not approved: still gated.
await refused('generate_3d', { projectId, imageUrl: 'https://example.com/x.png' }, /approved plan/)

// ---------- 3. the editor's click approves, through the decision path ----------
const approveRes = await answer(projectId, decisionId, { optionId: 'approve' })
const approveBody = await approveRes.text()
assert.equal(approveRes.status, 200, approveBody)
const approved = JSON.parse(approveBody) as { plan?: { status: string } }
assert.equal(approved.plan?.status, 'approved', 'answering the decision must flip the plan')
const plan1 = await ok('get_plan', { projectId })
assert.match(plan1.text, /\[approved\]/, plan1.text)

// A second answer is refused — first answer wins, unchanged by refs.
const again = await answer(projectId, decisionId, { optionId: 'request_changes' })
assert.equal(again.status, 409, 'second answer must 409')

// ---------- 4. the roster and the budget are enforced by arithmetic ----------
await refused(
  'generate_image',
  { projectId, prompt: 'a red sphere' },
  /does not budget image/,
)
await refused(
  'generate_3d',
  { projectId, imageUrl: 'https://example.com/x.png', model: 'hunyuan3d' },
  /budget|credits left/,
)

// ---------- 5. a failed generation returns its budget to the plan ----------
// The check-fal trick: fal accepts a 3D submission whose "image" is not one,
// and its runner rejects it — the whole failure path, no inference billed.
const settleBadGeneration = async () => {
  const bad = await ok(
    'generate_3d',
    { projectId, imageUrl: 'https://example.com/definitely-not-an-image.png', model: 'trellis' },
    true,
  )
  let settled = bad.data
  for (let i = 0; i < 20 && settled.status === 'pending'; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    const status = await ok('get_generation_status', { projectId })
    settled = (status.data.jobs as any[]).find((j) => j.id === bad.data.jobId) ?? settled
  }
  assert.equal(settled.status, 'failed', JSON.stringify(settled).slice(0, 300))
  const status = await ok('get_generation_status', { projectId })
  return (status.data.jobs as any[]).find((j) => j.id === bad.data.jobId)
}
const row = await settleBadGeneration()
assert.equal(row.plan_id, plan.id, 'the job must record which plan it drew from')
const plan2 = await ok('get_plan', { projectId })
const planRow = (plan2.data.plans as any[]).find((p) => p.id === plan.id)
assert.equal(
  planRow.spentCredits,
  0,
  `a failed generation must refund the plan budget: ${JSON.stringify(planRow)}`,
)
assert.equal(await balance(), startBalance, 'and the credits themselves')

// ---------- 6. a note-only answer is changes_requested; the budget stands ----------
const rev2 = await ok('propose_plan', {
  projectId,
  summary: 'Second thoughts',
  scenes: [{ title: 'Intro', narration: 'Shorter now.' }],
  narrationTakes: 1,
})
const note = await answer(projectId, rev2.data.decisionId, { note: 'slower pacing please' })
assert.equal(note.status, 200, `note-only answer failed: ${note.status}`)
const plan3 = await ok('get_plan', { projectId })
assert.match(plan3.text, /\[changes_requested\]/, plan3.text)
assert.match(plan3.text, /active budget is rev 1/, `rev 1 must still meter: ${plan3.text}`)

// ============ Phase 2: the asset review lifecycle ============
// The narration takes below are real ElevenLabs syntheses (~1 credit each, 4
// total) — the cheapest honest way to mint assets whose provenance differs.

// ---------- 8. an agent-authored take lands pending, attached to the doc ----------
const scene = await ok('add_scene', { projectId, name: 'Intro', duration: 4 })
const sceneId = scene.data.sceneId as string
await ok('set_narration', {
  projectId,
  sceneId,
  text: 'A circle is every point at one distance.',
})
const take1 = await ok('generate_narration', { projectId, sceneId }, true)
assert.equal(take1.data.reviewStatus, 'pending', take1.text)
assert.match(take1.text, /PENDING REVIEW/, take1.text)
const audio1 = take1.data.assetId as string

// ---------- 9. the render last-net refuses, free, naming the file ----------
const render = await run('render_video', { projectId }, true)
assert.equal(render.status, 403, `render must refuse unapproved narration: ${render.body}`)
assert.match(render.body, /request_review/, render.body)

// ---------- 10. the placement gate refuses a pending asset ----------
const track = await ok('add_audio_track', { projectId, name: 'voice', kind: 'voice' })
const place = await run('add_audio_clip', {
  projectId,
  trackId: track.data.trackId,
  assetId: audio1,
})
assert.equal(place.status, 403, `placement must refuse pending: ${place.body}`)
assert.match(place.body, /pending review/, place.body)

// ---------- 11. rejection with a note is the iteration signal ----------
const review1 = await ok('request_review', { projectId, assetIds: [audio1] })
assert.match(review1.text, /STOP — WAITING ON THE HUMAN/, review1.text)
const reject = await answer(projectId, review1.data.decisionId, {
  optionId: 'request_changes',
  note: 'too fast',
})
assert.equal(reject.status, 200, 'rejecting must succeed')
const listed = await ok('list_assets', { projectId })
assert.match(listed.text, /REJECTED: "too fast"/, listed.text)
const rereview = await run('request_review', { projectId, assetIds: [audio1] })
assert.match(rereview.body, /already rejected/, 'a rejected file is history, not a queue entry')
const placeRejected = await run('add_audio_clip', {
  projectId,
  trackId: track.data.trackId,
  assetId: audio1,
})
assert.match(placeRejected.body, /revises/, 'the refusal must teach the iteration path')

// ---------- 12. regeneration links the lineage and re-enters review ----------
const take2 = await ok('generate_narration', { projectId, sceneId }, true)
assert.equal(take2.data.reviewStatus, 'pending', 'rejected text must not auto-approve')
const audio2 = take2.data.assetId as string
const listed2 = await ok('list_assets', { projectId })
assert.match(
  listed2.text,
  new RegExp(`rev of ${audio1.slice(0, 8)}`),
  `the new take must record what it revises: ${listed2.text}`,
)

// ---------- 13. approval unlocks placement ----------
const review2 = await ok('request_review', { projectId, assetIds: [audio2] })
const approve2 = await answer(projectId, review2.data.decisionId, { optionId: 'approve' })
assert.equal(approve2.status, 200, 'approving must succeed')
const placed = await ok('add_audio_clip', {
  projectId,
  trackId: track.data.trackId,
  assetId: audio2,
})
assert.match(placed.text, /placed/, placed.text)

// ---------- 14. re-synthesis of approved text auto-approves ----------
const take3 = await ok('generate_narration', { projectId, sceneId }, true)
assert.equal(take3.data.reviewStatus, 'approved', take3.text)
assert.match(take3.data.reviewReason ?? '', /re-synthesis/, JSON.stringify(take3.data))

// ---------- 15. the human's own words never queue for their own approval ----------
const docRes = await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
const { version } = (await docRes.json()) as { version: number }
const opRes = await fetch(`${API}/api/projects/${projectId}/ops`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({
    id: crypto.randomUUID(),
    baseVersion: version,
    actor: { type: 'user' },
    ops: [{ kind: 'narration.set', sceneId, narration: { text: 'Hand-typed words.' } }],
  }),
})
assert.equal(opRes.status, 200, `the user-actor edit must land: ${await opRes.text()}`)
const take4 = await ok('generate_narration', { projectId, sceneId }, true)
assert.equal(take4.data.reviewStatus, 'approved', take4.text)
assert.match(take4.data.reviewReason ?? '', /human-authored/, JSON.stringify(take4.data))

// The four takes drew the approved plan's budget down by their real cost.
const planAfter = await ok('get_plan', { projectId })
const meterRow = (planAfter.data.plans as any[]).find((p) => p.id === plan.id)
assert.equal(meterRow.spentCredits, 4, `four 1-credit takes must meter: ${JSON.stringify(meterRow)}`)

// ---------- 7. review mode off restores today's behaviour ----------
await ok('set_review_mode', { projectId, enabled: false })
const beforeUngated = await balance()
// The same rejected submission now sails past where the gate refused it —
// and is settled before the project goes, or its debit would strand.
const ungatedRow = await settleBadGeneration()
assert.equal(ungatedRow.plan_id, null, 'ungated generation must not touch any plan')
assert.equal(await balance(), beforeUngated, 'and still refunds its credits')

await ok('delete_project', { projectId, confirm: true })
const endBalance = await balance()
console.log(
  `check-review OK — phase 1 (gate, approval, roster, budget, refund, changes_requested, ungating) ` +
    `and phase 2 (pending provenance, render last-net, placement gates, reject/iterate/lineage, ` +
    `approval unlock, script auto-approvals, budget metering) all verified; ` +
    `balance ${startBalance} → ${endBalance} (the four narration takes)`,
)
