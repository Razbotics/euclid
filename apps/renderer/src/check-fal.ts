/**
 * Generative assets through the fal provider (plans/009), end to end.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-fal.ts
 *
 * **SPENDS a small amount of real money** — one flux-schnell image, a few
 * tenths of a US cent. Nothing else here runs an inference: the refund test
 * is deliberately built on a request fal *rejects*, so it exercises the whole
 * failure path without paying for it.
 *
 * Needs `dev:api` with FAL_KEY in the environment. No renderer required —
 * generated files are project assets; only 3D models reach the stage, via
 * import_mesh (see check-glb.ts).
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'

/** `paid=1` is the credit-spending executor; the gateway refuses to charge without it. */
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
const balance = async (): Promise<number> => {
  const res = await fetch(`${API}/api/billing/balance`, { headers: H })
  return ((await res.json()) as { balance: number }).balance
}

const projectId = (await ok('create_project', { name: 'Fal Check' })).data.id
// Review mode is on by default (plans/010), and it gates every paid generation
// behind an approved plan. This script is testing the provider, not the review
// lifecycle — check-review.ts owns that — so it opts out explicitly.
await ok('set_review_mode', { projectId, enabled: false })

// ---------- 1. an image really arrives, and is really a file ----------
const before = await balance()
const gen = await ok('generate_image', {
  projectId,
  prompt: 'a single matte grey ceramic sphere on a plain white backdrop, studio light',
  model: 'flux-schnell',
  aspectRatio: '1:1',
  path: '/images/sphere.jpg',
}, true)
assert.equal(
  gen.data.status,
  'done',
  `flux-schnell should finish inside the inline wait, got "${gen.data.status}". ` +
    `If this is 'pending', the model got slower and INLINE_WAIT_MS needs revisiting: ${gen.text}`,
)
assert.ok(gen.data.assetId, 'a finished generation must name its asset')

const afterGen = await balance()
assert.equal(
  before - afterGen,
  gen.data.cost,
  `credits must be debited exactly once: ${before} → ${afterGen} for a ${gen.data.cost}-credit call`,
)

// The bytes must actually be in R2 and be an image — a row pointing at nothing
// is the failure the asset registry exists to prevent.
const file = await fetch(`${API}/api/assets/${gen.data.assetId}`, { headers: H })
assert.equal(file.status, 200, 'the stored asset must be downloadable')
const bytes = Buffer.from(await file.arrayBuffer())
assert.ok(bytes.length > 10_000, `a generated image should not be tiny (${bytes.length} bytes)`)
const mime = file.headers.get('content-type') ?? ''
assert.match(mime, /^image\//, `stored with an image mime, got ${mime}`)
// Magic bytes, because a JSON error page served with an image mime would pass
// every check above.
const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8
const isPng = bytes[0] === 0x89 && bytes[1] === 0x50
assert.ok(isJpeg || isPng, 'the stored bytes must actually be a JPEG or PNG, not an error page')
writeFileSync(`${OUT}/check-fal-image.jpg`, bytes)

// ---------- 2. it lands in the project filesystem where it was asked to ----------
const assets = await ok('list_assets', { projectId })
assert.match(assets.text, /sphere\.jpg/, `the generated file should be filed at its path: ${assets.text}`)
assert.match(assets.text, /images\//, 'and grouped under the folder its path names')

// ---------- 3. a failed generation refunds in full ----------
// An image-to-3D call pointed at a URL that is not an image. fal accepts the
// submission and its runner rejects it, which is exactly the shape of a real
// failure — and costs nothing, because no inference runs.
const beforeFail = await balance()
const bad = await ok('generate_3d', {
  projectId,
  imageUrl: 'https://example.com/definitely-not-an-image.png',
  model: 'trellis',
}, true)
// It may fail inside the inline wait or after it; poll until it settles.
let settled = bad.data
for (let i = 0; i < 20 && settled.status === 'pending'; i++) {
  await new Promise((r) => setTimeout(r, 3000))
  const status = await ok('get_generation_status', { projectId })
  settled = (status.data.jobs as any[]).find((j) => j.id === bad.data.jobId) ?? settled
}
assert.equal(
  settled.status,
  'failed',
  `a 3D generation from a non-image must fail rather than hang: ${JSON.stringify(settled).slice(0, 300)}`,
)
const afterFail = await balance()
assert.equal(
  afterFail,
  beforeFail,
  `a failed generation must refund in full: ${beforeFail} → ${afterFail}`,
)

// ---------- 4. polling is idempotent ----------
// There is no worker, so get_generation_status is what collects a job. Calling
// it repeatedly must not re-download, re-store or re-charge.
const beforePoll = await balance()
await ok('get_generation_status', { projectId })
await ok('get_generation_status', { projectId })
assert.equal(await balance(), beforePoll, 'polling must never move the balance')
const listed = await ok('list_assets', { projectId })
const sphereCount = (listed.text.match(/sphere\.jpg/g) ?? []).length
assert.equal(sphereCount, 1, `polling twice must not duplicate the asset (${sphereCount} copies)`)

// ---------- 5. the errors teach ----------
const unknown = await run('generate_image', { projectId, prompt: 'x', model: 'not-a-model' }, true)
assert.equal(unknown.status, 400, 'an unknown model is refused')

const noImage = await run('generate_3d', { projectId, model: 'trellis' }, true)
assert.equal(noImage.status, 400, 'image-to-3D without an image is refused before it costs anything')

// ---------- 6. grounding: what a model will and will not accept ----------
// All free — every one of these is refused before fal is contacted, which is
// the property under test as much as the wording is. The paid half (a real
// grounded generation) lives in check-fal-roster.ts.
const beforeRefusals = await balance()
const groundTextOnly = await run(
  'generate_image',
  { projectId, prompt: 'x', model: 'flux-schnell', imageUrl: gen.data.assetId },
  true,
)
assert.equal(
  groundTextOnly.status,
  400,
  'a text-only model handed an imageUrl must be refused, not quietly ignore it',
)
assert.match(
  groundTextOnly.body,
  /flux-i2i/,
  `the refusal must name a model that does take one: ${groundTextOnly.body}`,
)

const groundNoImage = await run('generate_image', { projectId, prompt: 'x', model: 'flux-i2i' }, true)
assert.equal(groundNoImage.status, 400, 'an image-to-image model with no imageUrl is refused')

const groundAspect = await run(
  'generate_image',
  { projectId, prompt: 'x', model: 'flux-i2i', imageUrl: gen.data.assetId, aspectRatio: '16:9' },
  true,
)
assert.equal(
  groundAspect.status,
  400,
  'aspectRatio on a model that takes its shape from the reference must be refused, not ignored',
)

const groundStrength = await run(
  'generate_video',
  { projectId, prompt: 'x', model: 'ltx-video-i2v', imageUrl: gen.data.assetId, strength: 0.5 },
  true,
)
assert.equal(groundStrength.status, 400, 'strength on an image-to-video model is refused')

const groundMissing = await run(
  'generate_image',
  { projectId, prompt: 'x', model: 'flux-i2i', imageUrl: 'ast_nope' },
  true,
)
assert.equal(groundMissing.status, 404, 'an imageUrl naming nothing is refused')
assert.match(groundMissing.body, /list_assets/, 'and says where the ids come from')

// Not one of the five refusals above reached fal, so none of them may have
// moved the balance. This is the assertion the others exist to protect: a
// refusal that charged would be worse than one that never fired.
assert.equal(
  await balance(),
  beforeRefusals,
  'refused combinations must never cost credits',
)

// The doc has to be honest that a generated file is not yet in the video.
const described = await fetch(`${API}/api/agent/tools/describe`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ names: ['generate_3d'] }),
})
const doc3d = await described.text()
// This assertion used to require the opposite — that the doc say the engine
// *cannot* draw a GLB. import_mesh made that false, and a test enforcing a
// stale sentence is worse than no test: it keeps the lie in place.
assert.match(doc3d, /import_mesh/, 'generate_3d must point at the tool that draws its output')
assert.doesNotMatch(
  doc3d,
  /engine cannot draw this/i,
  'and must not still claim the engine cannot draw a GLB',
)

await ok('delete_project', { projectId, confirm: true })

console.log(
  `fal OK — flux-schnell produced ${Math.round(bytes.length / 1024)}KB of real ${mime} at /images/sphere.jpg ` +
    `for ${gen.data.cost} credits (${before} → ${afterGen}), filed in the project tree. ` +
    `A rejected 3D request failed and refunded in full (${beforeFail} → ${afterFail}), ` +
    `double-polling changed neither the balance nor the file count, and the unknown-model, ` +
    `missing-image and import_mesh pointers all teach. Image at ${OUT}/check-fal-image.jpg`,
)
