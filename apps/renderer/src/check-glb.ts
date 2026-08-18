/**
 * GLB import (plans/009): a generated 3D model becomes a solid the engine
 * draws. Run: pnpm --filter @euclid/renderer exec tsx src/check-glb.ts
 *
 * **Spends ~17 credits** (one flux-schnell image + one trellis 3D generation),
 * a few cents. Needs `dev:api` with FAL_KEY, `dev:web`, and `render-worker.ts`.
 *
 * The interesting assertions are the two an importer gets wrong quietly:
 * orientation (glTF is Y-up, this system is Y-down, and negating an axis
 * reverses winding — an inside-out model renders as a hollow shell with an
 * identical silhouette) and document size (imported geometry is stored in the
 * document, which lives under one 128 KiB Durable Object key).
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { buildMesh, decimateMesh, normalizeMesh, orientOutward, parseGlb, signedVolume } from '@euclid/dsl'

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

// ---------- 0. the pipeline is pure, and orientation is measured ----------
// A cube wound INWARD on purpose: orientOutward must detect and repair it,
// because that is precisely what the Y-up→Y-down flip does to a real file.
// Derived from a known-good generator rather than hand-written indices: take
// the cube every other check trusts and reverse every face. That is exactly
// what negating an axis does to a real file, and it cannot be got subtly wrong
// the way a hand-typed vertex list can.
const goodCube = buildMesh({ kind: 'cube', size: 200 })
const inside = {
  verts: goodCube.verts,
  faces: goodCube.faces.map(([a, b, c]) => [a, c, b] as [number, number, number]),
}
assert.ok(signedVolume(goodCube) > 0, 'the generator itself must wind outward')
assert.ok(signedVolume(inside) < 0, 'the fixture must really be inside out')
assert.ok(
  signedVolume(orientOutward(inside)) > 0,
  'orientOutward must repair an inside-out mesh — an unrepaired one renders as a hollow shell ' +
    'with the same silhouette, so nothing downstream can see the difference',
)
assert.equal(signedVolume(orientOutward(orientOutward(inside))) > 0, true, 'and be idempotent')

// A file that is not a GLB is refused by name rather than producing nothing.
let refused = ''
try {
  parseGlb(new TextEncoder().encode('this is not a model at all').buffer as ArrayBuffer)
} catch (e) {
  refused = (e as Error).message
}
assert.match(refused, /magic number/, `a non-GLB must say what it is not: "${refused}"`)

// ---------- 1. generate a model and import it ----------
const projectId = (await ok('create_project', { name: 'GLB Import Check' })).data.id

const image = await ok('generate_image', {
  projectId,
  prompt: 'a single carved stone owl statuette, plain white background, centred, studio light',
  model: 'flux-schnell',
  path: '/images/owl.jpg',
}, true)
assert.equal(image.data.status, 'done', `seed image should land: ${image.text}`)

// generate_3d needs a URL the *provider* can fetch, and a project asset is not
// publicly readable — which is the `upload_asset` gap plans/003 names. So the
// seed is minted straight from fal here; it is a fixture, not the thing under
// test.
const FAL_KEY = process.env.FAL_KEY ?? ''
assert.ok(FAL_KEY, 'FAL_KEY is required — this check generates a real model')
const falAuth = { Authorization: `Key ${FAL_KEY}`, 'content-type': 'application/json' }
const submitted = (await (
  await fetch('https://queue.fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: falAuth,
    body: JSON.stringify({
      prompt: 'a single carved stone owl statuette, plain white background, centred',
      image_size: 'square_hd',
      num_images: 1,
    }),
  })
).json()) as any
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const st = (await (await fetch(submitted.status_url, { headers: falAuth })).json()) as any
  if (st.status === 'COMPLETED') break
}
const seedBody = (await (await fetch(submitted.response_url, { headers: falAuth })).json()) as any
const seedUrl = seedBody?.images?.[0]?.url as string | undefined
assert.ok(seedUrl, `could not mint a seed image: ${JSON.stringify(seedBody).slice(0, 200)}`)

const gen = await ok('generate_3d', { projectId, imageUrl: seedUrl, model: 'trellis' }, true)
let job = gen.data
for (let i = 0; i < 40 && job.status === 'pending'; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  const s = await ok('get_generation_status', { projectId })
  const found = (s.data.jobs as any[]).find((j) => j.id === (job.jobId ?? job.id))
  if (found) job = { ...found, jobId: found.id, assetId: found.asset_id, status: found.status }
}
assert.equal(job.status, 'done', `the 3D generation must finish: ${JSON.stringify(job).slice(0, 200)}`)

// ---------- 2. it becomes a solid, correctly oriented ----------
const scene = (await ok('add_scene', { projectId, name: 'Owl', duration: 6, background: BG })).data.sceneId
const imported = await ok('import_mesh', {
  projectId, sceneId: scene, assetId: job.assetId,
  x: 960, y: 540, size: 520, targetTriangles: 1500, fill: '#c9d1d9',
})
assert.match(imported.text, /reduced to/, 'the response must say what it simplified')
assert.ok(
  imported.data.sourceTriangles > imported.data.triangles,
  `decimation must actually reduce: ${imported.data.sourceTriangles} → ${imported.data.triangles}`,
)
assert.ok(
  imported.data.triangles <= 1500,
  `and respect the target: got ${imported.data.triangles}`,
)

await ok('set_camera', { projectId, sceneId: scene, yaw: 0.5, pitch: 0.3 })

// Culled and unculled must agree, exactly as for an authored solid. This is
// the assertion that catches an inside-out import: a hollow shell looks
// completely different with culling off, while a correct solid does not.
const shot = await ok('preview_frames', { projectId, at: [2], columns: 1 })
if (shot.image) writeFileSync(`${OUT}/check-glb-import.png`, Buffer.from(shot.image.base64, 'base64'))
const litCulled = (shot.data.ink as number[])[0]!
assert.ok(litCulled > 0.02, `the imported solid must actually draw (${pct(litCulled)})`)

await ok('update_node', {
  projectId, sceneId: scene, nodeId: imported.data.nodeId, patch: { cull: false },
})
const litOpen = ((await ok('preview_frames', { projectId, at: [2], columns: 1 })).data.ink as number[])[0]!
const delta = Math.abs(litCulled - litOpen) / Math.max(litCulled, litOpen)
assert.ok(
  delta < 0.08,
  `a correctly wound import must look the same culled or not (${pct(litCulled)} vs ${pct(litOpen)}, ` +
    `${pct(delta)} apart). A wide gap means the faces are inside out and culling is keeping the far surface.`,
)

// ---------- 3. the document budget is enforced, not discovered ----------
const tooBig = await run('import_mesh', {
  projectId, sceneId: scene, assetId: job.assetId, x: 960, y: 540, size: 400,
  targetTriangles: 2000,
})
// Either it fits (fine) or it is refused with a number and a remedy.
if (tooBig.status !== 200) {
  assert.match(tooBig.body, /Durable Object|document/, 'a refusal must explain the budget')
  assert.match(tooBig.body, /targetTriangles/, 'and name the argument to lower')
}

const wrongKind = await run('import_mesh', {
  projectId, sceneId: scene, assetId: image.data.assetId, x: 960, y: 540,
})
assert.equal(wrongKind.status, 400, 'importing an image as a mesh is refused')
assert.match(wrongKind.body, /not a 3D model/, 'and says what the asset actually is')

await ok('delete_project', { projectId, confirm: true })
console.log(
  `glb OK — inside-out fixture repaired (volume ${signedVolume(inside).toFixed(0)} → ` +
    `${signedVolume(orientOutward(inside)).toFixed(0)}), a real trellis model imported at ` +
    `${imported.data.sourceTriangles}→${imported.data.triangles} triangles, culled/unculled ` +
    `agree to ${pct(delta)}, and the wrong-kind and budget errors teach. ` +
    `Frame at ${OUT}/check-glb-import.png`,
)
