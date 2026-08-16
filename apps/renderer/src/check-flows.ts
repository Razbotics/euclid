/**
 * Flows (plans/006 Phase D): arrows that track what they point at, and nodes
 * that travel along paths — measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-flows.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * The claim here is *tracking*: an arrow between two nodes must be recomputed
 * every frame, not baked at creation. Lit fraction alone cannot see that — the
 * arrow is lit either way — so the test frames the camera tightly on the place
 * the head must reach after its target has moved. An anchored arrow lights that
 * frame; one baked at creation leaves it empty.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'
const BG = '#101418'

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(
    `preview backend not running at ${PREVIEW}\n` +
      '  pnpm --filter @euclid/renderer exec tsx src/render-worker.ts',
  )
  process.exit(1)
}

const run = async (name: string, args: Record<string, unknown>) => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args)
  assert.equal(r.status, 200, `${name} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any; image?: { base64: string } }
}
async function inkAt(projectId: string, at: number[], save?: string): Promise<number[]> {
  const shot = await ok('preview_frames', { projectId, at, columns: at.length })
  if (save && shot.image) writeFileSync(`${OUT}/${save}`, Buffer.from(shot.image.base64, 'base64'))
  return shot.data.ink as number[]
}
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

const projectId = (await ok('create_project', { name: 'Flow Check' })).data.id

// ---------- 1. an arrow tracks the node it is anchored to ----------
// A box starts beside its target and travels far away. The camera is framed on
// the corridor the arrow must stretch across once it has gone: an anchored
// arrow lights it, a baked one is nowhere near.
const trackScene = (await ok('add_scene', { projectId, name: 'Track', duration: 6, background: BG }))
  .data.sceneId
const box = (
  await ok('add_shape', {
    projectId, sceneId: trackScene, shape: 'rect', x: 500, y: 700, width: 220, height: 120,
    fill: '#58c4dd',
  })
).data.nodeId
const target = (
  await ok('add_shape', {
    projectId, sceneId: trackScene, shape: 'circle', x: 500, y: 300, radius: 90, fill: '#fc6255',
  })
).data.nodeId
const link = (await ok('connect', { projectId, sceneId: trackScene, from: box, to: target })).data
  .nodeId
await ok('animate', {
  projectId, sceneId: trackScene, nodeId: box, property: 'position',
  to: { x: 1500, y: 700 }, start: 1, duration: 3,
})
// Straight down the middle of where the arrow ends up, and nowhere near where
// it was drawn at t=0.
await ok('set_camera', { projectId, sceneId: trackScene, x: 1050, y: 520, zoom: 6 })
const [before, after] = await inkAt(projectId, [0.5, 5], 'check-flows-track.png')
assert.ok(
  before! < 0.01,
  `nothing should cross this frame before the box moves (${pct(before!)})`,
)
assert.ok(
  after! > before! * 5 && after! > 0.02,
  `the arrow must be recomputed as its anchor moves: ${pct(before!)} → ${pct(after!)}. ` +
    `An arrow baked at creation would leave this frame empty.`,
)

// ---------- 2. it stops at the edge, and a curve bows off the chord ----------
const shapeScene = (await ok('add_scene', { projectId, name: 'Shape', duration: 4, background: BG }))
  .data.sceneId
const a = (
  await ok('add_shape', {
    projectId, sceneId: shapeScene, shape: 'circle', x: 500, y: 540, radius: 120, fill: '#1b2733',
    stroke: '#58c4dd',
  })
).data.nodeId
const b = (
  await ok('add_shape', {
    projectId, sceneId: shapeScene, shape: 'circle', x: 1420, y: 540, radius: 120, fill: '#1b2733',
    stroke: '#58c4dd',
  })
).data.nodeId
await ok('connect', { projectId, sceneId: shapeScene, from: a, to: b, curve: 0.25 })
await ok('connect', { projectId, sceneId: shapeScene, from: b, to: a, curve: 0.25 })
const [pair] = await inkAt(projectId, [6 + 2], 'check-flows-curve.png')
assert.ok(pair! > 0.004, `two curved connectors must draw (${pct(pair!)})`)

// A straight pair in the same geometry covers less ground than a bowed pair,
// because the two bows separate instead of lying on top of one another.
const straightScene = (
  await ok('add_scene', { projectId, name: 'Straight', duration: 4, background: BG })
).data.sceneId
const c = (
  await ok('add_shape', {
    projectId, sceneId: straightScene, shape: 'circle', x: 500, y: 540, radius: 120,
    fill: '#1b2733', stroke: '#58c4dd',
  })
).data.nodeId
const d = (
  await ok('add_shape', {
    projectId, sceneId: straightScene, shape: 'circle', x: 1420, y: 540, radius: 120,
    fill: '#1b2733', stroke: '#58c4dd',
  })
).data.nodeId
await ok('connect', { projectId, sceneId: straightScene, from: c, to: d })
await ok('connect', { projectId, sceneId: straightScene, from: d, to: c })
const [straight] = await inkAt(projectId, [10 + 2])
assert.ok(
  pair! > straight!,
  `curved connectors must separate rather than overlap: straight ${pct(straight!)} ` +
    `vs curved ${pct(pair!)}`,
)

// ---------- 3. a node travelling a path ----------
// The camera watches the far end of the path. The token only reaches it if the
// follow is actually driving its position by arc length.
const flowScene = (await ok('add_scene', { projectId, name: 'Flow', duration: 8, background: BG }))
  .data.sceneId
const wire = (
  await ok('add_path', {
    projectId, sceneId: flowScene, x: 300, y: 300,
    points: [
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 400 }, { x: 900, y: 400 },
      { x: 900, y: 700 },
    ],
    stroke: '#3a4450', strokeWidth: 4,
  })
).data.nodeId
const token = (
  await ok('add_shape', {
    projectId, sceneId: flowScene, shape: 'circle', x: 300, y: 300, radius: 34, fill: '#e8c74a',
  })
).data.nodeId
const flow = await ok('flow_along', {
  projectId, sceneId: flowScene, nodeId: token, pathId: wire, start: 1, duration: 4,
})
// 300 + 400 + 600 + 300 down the dog-leg.
assert.match(flow.text, /1600px/, 'the response reports the real arc length of the path')

await ok('set_camera', { projectId, sceneId: flowScene, x: 1200, y: 1000, zoom: 5 })
// Track 6s + Shape 4s + Straight 4s, so the flow scene opens at 14s.
const travel = await inkAt(projectId, [14 + 1.2, 14 + 5.5], 'check-flows-travel.png')
assert.ok(
  travel[0]! < travel[1]!,
  `the token must arrive at the far end of the path: ${travel.map(pct).join(' → ')}`,
)
// A 34px token at zoom 5 covers about 4.4% of the frame; anything near that
// is the token itself rather than the path line clipping the corner.
assert.ok(travel[1]! > 0.03, 'and be plainly there, not a sliver')

// ---------- 4. the errors teach ----------
const missing = await run('connect', { projectId, sceneId: shapeScene, from: a, to: 'nope_1234' })
assert.equal(missing.status, 400)
assert.match(missing.body, /does not exist in this scene/, 'a dangling anchor is refused up front')
assert.match(missing.body, /resolved every\s+frame/, 'and says why the id has to be real')

const selfLink = await run('connect', { projectId, sceneId: shapeScene, from: a, to: a })
assert.equal(selfLink.status, 400)
assert.match(selfLink.body, /no direction to point in/, 'an arrow to itself is refused')

// A path told to travel along itself — the type check passes, so this is the
// guard that has to catch it.
const selfPath = await run('flow_along', {
  projectId, sceneId: flowScene, nodeId: wire, pathId: wire, start: 0, duration: 1,
})
assert.equal(selfPath.status, 400)
assert.match(selfPath.body, /cannot travel along itself/, 'and so is a path following itself')

const wrongType = await run('flow_along', {
  projectId, sceneId: shapeScene, nodeId: a, pathId: b, start: 0, duration: 1,
})
assert.equal(wrongType.status, 400)
assert.match(wrongType.body, /not a path/, 'flowing along a non-path names what a path comes from')

// A position track loses to a flow, which is the opposite of the usual rule,
// so the response has to say so rather than leaving it to be discovered.
await ok('animate', {
  projectId, sceneId: flowScene, nodeId: token, property: 'position',
  to: { x: 100, y: 100 }, start: 0, duration: 1,
})
const shadowed = await ok('flow_along', {
  projectId, sceneId: flowScene, nodeId: token, pathId: wire, start: 1, duration: 4,
})
assert.match(shadowed.text, /also has a position track, and the flow wins/, 'the clash is reported')

// ---------- 5. a flow is a key moment ----------
const sheet = await ok('preview_frames', { projectId })
writeFileSync(`${OUT}/check-flows-sheet.png`, Buffer.from(sheet.image!.base64, 'base64'))
assert.ok(
  (sheet.data.moments as { kind: string }[]).some((m) => m.kind === 'follow'),
  'mid-flight is a frame worth capturing, so a flow is a key moment',
)

await ok('delete_project', { projectId, confirm: true })

console.log(
  `flows OK — tracking ${pct(before!)} → ${pct(after!)} with the camera on the corridor the ` +
    `arrow must stretch across, curved pair ${pct(pair!)} vs straight ${pct(straight!)}, ` +
    `path travel ${travel.map(pct).join('→')}. Dangling, self-link, wrong-type and ` +
    `track-shadowing messages all teach. Frames in ${OUT}/check-flows-*.png`,
)
