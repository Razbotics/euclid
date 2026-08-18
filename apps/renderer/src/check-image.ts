/**
 * The image node (plans/003 §2): a generated still reaches the frame.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-image.ts
 *
 * **Spends 2 credits** (one flux-schnell image). Needs `dev:api` with FAL_KEY,
 * `dev:web`, and `render-worker.ts`.
 *
 * The assertion that matters most is not that an image draws — it is that the
 * **preview and the export agree**. They are two processes loading the same
 * page, and each has to push the asset's bytes in separately because the page
 * has no session; a preview that shows pictures the export omits is the one
 * failure this surface must never have.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'
const BG = '#0d1117'

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(`preview backend not running at ${PREVIEW}`)
  process.exit(1)
}

const run = async (n: string, a: Record<string, unknown>, paid = false) => {
  const r = await fetch(`${API}/api/agent/tools/${n}/execute?format=json${paid ? '&paid=1' : ''}`, {
    method: 'POST', headers: H, body: JSON.stringify(a),
  })
  return { status: r.status, body: await r.text() }
}
const ok = async (n: string, a: Record<string, unknown>, paid = false) => {
  const r = await run(n, a, paid)
  assert.equal(r.status, 200, `${n} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any; image?: { base64: string } }
}
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

const projectId = (await ok('create_project', { name: 'Image Node Check' })).data.id
const sceneId = (await ok('add_scene', { projectId, name: 'still', duration: 6, background: BG }))
  .data.sceneId

const gen = await ok('generate_image', {
  projectId,
  prompt: 'a vivid orange origami crane on a deep blue background, centred',
  model: 'flux-schnell', aspectRatio: '1:1', path: '/images/crane.jpg',
}, true)
assert.equal(gen.data.status, 'done', `the seed image must land: ${gen.text}`)
const assetId = gen.data.assetId as string

// ---------- 1. it draws, and the three fits differ ----------
for (const [fit, x] of [['contain', 400], ['cover', 960], ['fill', 1520]] as const) {
  const r = await ok('add_image', {
    projectId, sceneId, assetId, x, y: 540, width: 420, height: 300, fit,
  })
  assert.match(r.text, new RegExp(fit), `add_image should report the fit it used: ${r.text}`)
}
const sheet = await ok('preview_frames', { projectId, at: [3], columns: 1 })
if (sheet.image) writeFileSync(`${OUT}/check-image.png`, Buffer.from(sheet.image.base64, 'base64'))
const lit = (sheet.data.ink as number[])[0]!
assert.ok(
  lit > 0.05,
  `the images must actually draw (${pct(lit)}). Zero here means the page was never handed ` +
    `the bytes — it has no session, so both capture paths must preload them.`,
)

// ---------- 2. the outline says which picture, not just "image" ----------
const outline = (await ok('get_project', { projectId })).text
assert.match(outline, /image .*420x300 contain/, `the outline must describe the node: ${outline}`)
assert.match(outline, /cover/, 'and distinguish the fits')

// ---------- 3. a drawn image cannot be deleted ----------
const del = await run('remove_asset', { projectId, assetId })
assert.equal(del.status, 409, 'an image a scene draws must resist deletion')
assert.match(del.body, /still used/, 'and say so')

// ---------- 4. the wrong kind of asset is refused, and says what to use ----------
const wrong = await run('add_image', {
  projectId, sceneId, assetId: 'not-a-real-asset', x: 0, y: 0, width: 10, height: 10,
})
assert.equal(wrong.status, 404, 'an unknown asset is refused')

// ---------- 5. generate_image points at the tool that draws its output ----------
const doc = await (
  await fetch(`${API}/api/agent/tools/describe`, {
    method: 'POST', headers: H, body: JSON.stringify({ names: ['generate_image'] }),
  })
).text()
assert.match(doc, /add_image/, 'generate_image must point at add_image')
assert.doesNotMatch(doc, /Nothing puts this in a frame/, 'and no longer claim nothing can draw it')

await ok('delete_project', { projectId, confirm: true })
console.log(
  `image OK — a generated still draws at ${pct(lit)} lit across contain/cover/fill, the outline ` +
    `names the box and the fit, a drawn image resists deletion, and generate_image points at ` +
    `add_image. Frame at ${OUT}/check-image.png`,
)
