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

/**
 * Global start of a scene, asked of the document rather than added up by hand.
 * Counting scene durations in your head is how this file twice sampled the
 * wrong scene and then trusted the reading.
 */
async function sceneStart(projectId: string, sceneId: string): Promise<number> {
  const { doc } = (await (
    await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
  ).json()) as { doc: { scenes: { id: string; duration: number }[] } }
  let acc = 0
  for (const sc of doc.scenes) {
    if (sc.id === sceneId) return acc
    acc += sc.duration
  }
  throw new Error(`scene ${sceneId} not found`)
}

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
const flowAt = await sceneStart(projectId, flowScene)
const travel = await inkAt(projectId, [flowAt + 1.2, flowAt + 5.5], 'check-flows-travel.png')
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

// ---------- 6. pinned nodes ignore the camera ----------
// Milestone run 6's caption drifted across the frame and grew 46% as the space
// orbited behind it, because a node at the scene root really is in the world.
// Two identical labels, one pinned: the camera zooms hard, and only the
// unpinned one is dragged with it. Measured with the camera framed off-centre
// so a label that moves leaves the frame entirely.
const pinScene = (await ok('add_scene', { projectId, name: 'Pinned', duration: 6, background: BG }))
  .data.sceneId
const pinned = (
  await ok('add_shape', {
    projectId, sceneId: pinScene, shape: 'circle', x: 300, y: 250, radius: 70, fill: '#ffffff',
  })
).data.nodeId
const loose = (
  await ok('add_shape', {
    projectId, sceneId: pinScene, shape: 'circle', x: 300, y: 830, radius: 70, fill: '#ffffff',
  })
).data.nodeId
const pinAt = (await sceneStart(projectId, pinScene)) + 1
const [bothInWorld] = await inkAt(projectId, [pinAt])
await ok('pin_to_frame', { projectId, sceneId: pinScene, nodeId: pinned })
// Zoom 3 about the canvas centre throws anything at x=300 far out of frame.
await ok('set_camera', { projectId, sceneId: pinScene, zoom: 3 })
const [afterPin] = await inkAt(projectId, [pinAt], 'check-flows-pinned.png')
assert.ok(
  afterPin! > 0.004 && afterPin! < bothInWorld! * 0.75,
  `exactly one disc should survive the zoom: ${pct(bothInWorld!)} → ${pct(afterPin!)}`,
)
// The real invariant is that the camera cannot touch it at all: pinned ink is
// the same under a zoom about the centre, a pan somewhere else, and an orbit.
// Note it is never *magnified* either — a pinned node keeps its own size, so
// the reading stays one unzoomed disc rather than growing with the zoom.
// With the unpinned disc gone, whatever the frame holds is the pinned one —
// an orbit does not throw it out of frame the way a hard zoom does, so leaving
// it in would have measured both.
await ok('remove_node', { projectId, sceneId: pinScene, nodeId: loose })
await ok('set_camera', { projectId, sceneId: pinScene, reset: true })
await ok('set_camera', { projectId, sceneId: pinScene, x: 300, y: 250, zoom: 3 })
const [panned] = await inkAt(projectId, [pinAt])
await ok('set_camera', { projectId, sceneId: pinScene, reset: true })
await ok('set_camera', { projectId, sceneId: pinScene, yaw: 0.9, pitch: 0.4 })
const [orbited] = await inkAt(projectId, [pinAt])
const oneDisc = (Math.PI * 70 * 70) / (1920 * 1080)
for (const [what, v] of [['zoomed', afterPin!], ['panned', panned!], ['orbited', orbited!]] as const) {
  assert.ok(
    Math.abs(v - oneDisc) < oneDisc * 0.15,
    `${what}: a pinned node keeps its own size and place — expected ~${pct(oneDisc)}, got ${pct(v)}`,
  )
}

const nested = await ok('add_group', { projectId, sceneId: pinScene, x: 900, y: 540 })
const kid = (
  await ok('add_shape', {
    projectId, sceneId: pinScene, shape: 'circle', x: 0, y: 0, radius: 30, fill: '#58c4dd',
    parentId: nested.data.nodeId,
  })
).data.nodeId
const nestedPin = await ok('pin_to_frame', { projectId, sceneId: pinScene, nodeId: kid })
assert.match(
  nestedPin.text,
  /inside a group, which still moves it/,
  'pinning a grouped child is a contradiction and says so rather than pretending',
)

// ---------- 7. an arrow can point at one cell ----------
// Run 6 needed six proxy circles to draw six per-token arrows. This is the
// call it should have been able to make.
const cellScene = (await ok('add_scene', { projectId, name: 'Cells', duration: 6, background: BG }))
  .data.sceneId
const strip = (
  await ok('add_tokens', {
    projectId, sceneId: cellScene, labels: ['alpha', 'beta', 'gamma', 'delta'],
    x: 960, y: 300, fontSize: 44, cellWidth: 300, boxStroke: '#3a4450',
  })
).data.nodeId
const sink = (
  await ok('add_shape', {
    projectId, sceneId: cellScene, shape: 'circle', x: 960, y: 860, radius: 70, fill: '#1b2733',
    stroke: '#e8c74a',
  })
).data.nodeId
// One arrow, from the FIRST token. The two frames below are mirror images of
// each other either side of the strip's centre, and neither contains a token
// box — so the only thing that can light one and not the other is where the
// arrow actually leaves from. (Framing on the tokens themselves measured the
// boxes, which dominate the ink and say nothing about the anchor.)
await ok('connect', {
  projectId, sceneId: cellScene, from: { node: strip, cells: { cols: 0 } }, to: sink,
  stroke: '#7fb069', strokeWidth: 6,
})
const cellAt = (await sceneStart(projectId, cellScene)) + 3
await ok('set_camera', { projectId, sceneId: cellScene, x: 735, y: 565, zoom: 4 })
const [underFirst] = await inkAt(projectId, [cellAt], 'check-flows-cells.png')
await ok('set_camera', { projectId, sceneId: cellScene, reset: true })
await ok('set_camera', { projectId, sceneId: cellScene, x: 1185, y: 565, zoom: 4 })
const [underLast] = await inkAt(projectId, [cellAt])
assert.ok(
  underFirst! > underLast! * 3 && underFirst! > 0.01,
  `an arrow anchored to col 0 must leave from col 0: ${pct(underFirst!)} under the first ` +
    `token vs ${pct(underLast!)} under the last`,
)

// Anchor a second arrow to the LAST token and the mirror frame lights up too,
// which is the same claim from the other side.
await ok('connect', {
  projectId, sceneId: cellScene, from: { node: strip, cells: { cols: 3 } }, to: sink,
  stroke: '#7fb069', strokeWidth: 6,
})
const [underLastNow] = await inkAt(projectId, [cellAt])
assert.ok(
  underLastNow! > underLast! * 3,
  `and one anchored to col 3 lights the other side: ${pct(underLast!)} → ${pct(underLastNow!)}`,
)

const badCell = await run('connect', {
  projectId, sceneId: cellScene, from: { node: strip, cells: { cols: 9 } }, to: sink,
})
assert.equal(badCell.status, 400)
assert.match(badCell.body, /outside .* which is 1x4/, 'a cell the strip does not have is refused')

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
    `path travel ${travel.map(pct).join('→')}, pinned ${pct(afterPin!)}/${pct(panned!)}/` +
    `${pct(orbited!)} under three cameras, cell anchor ${pct(underFirst!)} vs ` +
    `${pct(underLast!)} on the wrong side. Dangling, self-link, wrong-type, out-of-range cell, ` +
    `grouped-pin and track-shadowing messages all teach. Frames in ${OUT}/check-flows-*.png`,
)
