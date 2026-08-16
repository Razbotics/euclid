/**
 * Pseudo-3D (plans/006 Phase C): projection plus depth cues, measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-3d.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * The plan's own verification: "a vector behind another must be occluded in
 * draw order and dimmer, or it reads as flat overlapping lines." Occlusion is
 * the hard one to measure, because a correct frame and an incorrectly-ordered
 * one contain the same shapes. The trick here is a disc painted the background
 * colour: invisible against the backdrop, but it still occludes whatever is
 * drawn before it. So the same two discs, with only their depths swapped, must
 * read as a bright frame one way round and an empty one the other — and that
 * difference is entirely draw order.
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

const projectId = (await ok('create_project', { name: '3D Check' })).data.id

// ---------- 1. occlusion is decided by depth, not by document order ----------
// Two discs at the canvas centre, sized so both project to the same radii
// whichever depth they are at: the visible one to 200px, the background-
// coloured one to 320px. The masking disc is invisible against the backdrop,
// so the only thing the lit fraction can be measuring is what covered what.
const occludeA = (await ok('add_scene', { projectId, name: 'Near in front', duration: 4, background: BG }))
  .data.sceneId
// Added in the *wrong* order on purpose — the near disc first — so document
// order cannot be what produces the right answer.
await ok('add_shape', {
  projectId, sceneId: occludeA, shape: 'circle', x: 960, y: 540, radius: 150, fill: '#ffffff',
})
await ok('add_shape', {
  projectId, sceneId: occludeA, shape: 'circle', x: 960, y: 540, radius: 400, fill: BG,
})
await ok('update_node', {
  projectId, sceneId: occludeA,
  nodeId: (await ok('get_scene', { projectId, sceneId: occludeA })).data.scene.nodes[0].id,
  patch: { z: 500 },
})
await ok('update_node', {
  projectId, sceneId: occludeA,
  nodeId: (await ok('get_scene', { projectId, sceneId: occludeA })).data.scene.nodes[1].id,
  patch: { z: -500 },
})

const occludeB = (await ok('add_scene', { projectId, name: 'Near behind', duration: 4, background: BG }))
  .data.sceneId
await ok('add_shape', {
  projectId, sceneId: occludeB, shape: 'circle', x: 960, y: 540, radius: 250, fill: '#ffffff',
})
await ok('add_shape', {
  projectId, sceneId: occludeB, shape: 'circle', x: 960, y: 540, radius: 240, fill: BG,
})
const bNodes = (await ok('get_scene', { projectId, sceneId: occludeB })).data.scene.nodes
await ok('update_node', { projectId, sceneId: occludeB, nodeId: bNodes[0].id, patch: { z: -500 } })
await ok('update_node', { projectId, sceneId: occludeB, nodeId: bNodes[1].id, patch: { z: 500 } })

const [visible, hidden] = await inkAt(projectId, [2, 6], 'check-3d-occlusion.png')
assert.ok(
  visible! > 0.03,
  `the white disc in front must be drawn over the mask behind it (${pct(visible!)})`,
)
assert.ok(
  hidden! < visible! * 0.1,
  `and swapping only their depths must hide it: ${pct(visible!)} → ${pct(hidden!)}. ` +
    `Equal readings would mean depth is not deciding draw order at all.`,
)

// ---------- 2. nearer is bigger ----------
const nearScene = (await ok('add_scene', { projectId, name: 'Near', duration: 4, background: BG })).data
  .sceneId
await ok('add_shape', {
  projectId, sceneId: nearScene, shape: 'circle', x: 960, y: 540, radius: 200, fill: '#ffffff',
})
await ok('update_node', {
  projectId, sceneId: nearScene,
  nodeId: (await ok('get_scene', { projectId, sceneId: nearScene })).data.scene.nodes[0].id,
  patch: { z: 500 },
})
const farScene = (await ok('add_scene', { projectId, name: 'Far', duration: 4, background: BG })).data
  .sceneId
await ok('add_shape', {
  projectId, sceneId: farScene, shape: 'circle', x: 960, y: 540, radius: 200, fill: '#ffffff',
})
await ok('update_node', {
  projectId, sceneId: farScene,
  nodeId: (await ok('get_scene', { projectId, sceneId: farScene })).data.scene.nodes[0].id,
  patch: { z: -500 },
})
const [nearInk, farInk] = await inkAt(projectId, [10, 14])
// Area goes as scale²: (2000/1500) / (2000/2500) = 1.667, squared is 2.78.
assert.ok(
  nearInk! > farInk! * 2.2,
  `the same disc must draw larger when nearer: ${pct(farInk!)} → ${pct(nearInk!)} (expected ~2.8x)`,
)

// ---------- 3. an arrow turning away from the camera foreshortens ----------
// A vector along +x, orbited a quarter turn until it points at the viewer.
// This is the plan's "flat overlapping lines" case: if the ends were not
// projected separately the arrow would keep its length through the turn.
const vecScene = (await ok('add_scene', { projectId, name: 'Turn', duration: 8, background: BG })).data
  .sceneId
await ok('add_vector3', {
  projectId, sceneId: vecScene, x: 960, y: 540,
  from: { x: -450, y: 0, z: 0 }, to: { x: 450, y: 0, z: 0 },
  strokeWidth: 14, headSize: 70,
})
await ok('orbit_camera', { projectId, sceneId: vecScene, degrees: 90, start: 1, duration: 4 })
const turn = await inkAt(projectId, [16 + 0.5, 16 + 3, 16 + 5.5], 'check-3d-foreshorten.png')
assert.ok(
  turn[2]! < turn[0]! * 0.35,
  `an arrow turned end-on must foreshorten: ${turn.map(pct).join(' → ')}`,
)
assert.ok(turn[1]! < turn[0]! && turn[1]! > turn[2]!, 'and shrink through the turn, not snap')

// ---------- 4. a space to look around: axes, a cloud, an orbit ----------
const spaceScene = (await ok('add_scene', { projectId, name: 'Space', duration: 10, background: BG }))
  .data.sceneId
await ok('add_axes3d', { projectId, sceneId: spaceScene, x: 960, y: 540, size: 420, strokeWidth: 6 })
const lattice: { x: number; y: number; z: number }[] = []
for (const gx of [-300, 0, 300]) {
  for (const gy of [-300, 0, 300]) {
    for (const gz of [-300, 0, 300]) lattice.push({ x: gx, y: gy, z: gz })
  }
}
await ok('add_points3', {
  projectId, sceneId: spaceScene, x: 960, y: 540, points: lattice, radius: 16, fill: '#e8c74a',
})
await ok('set_camera', { projectId, sceneId: spaceScene, pitch: 0.35 })
await ok('orbit_camera', { projectId, sceneId: spaceScene, degrees: 120, start: 0.5, duration: 8 })

// The plan asks for several camera angles, so this is the frame worth reading
// by eye — a lattice that stays a flat grid through an orbit is the failure.
const angles = await inkAt(
  projectId,
  [24 + 0.6, 24 + 3, 24 + 5.5, 24 + 8],
  'check-3d-angles.png',
)
assert.ok(angles.every((v) => v > 0.005), `the space must be drawn at every angle: ${angles.map(pct).join(' ')}`)
const spread = Math.max(...angles) - Math.min(...angles)
assert.ok(
  spread > 0.001,
  `an orbit must change what is on screen; the lit fraction barely moved (${angles.map(pct).join(' ')})`,
)

// A cloud reveals dot by dot, like every other stagger in the system.
const cloudScene = (await ok('add_scene', { projectId, name: 'Cloud', duration: 6, background: BG }))
  .data.sceneId
const cloudId = (
  await ok('add_points3', {
    projectId, sceneId: cloudScene, x: 960, y: 540,
    points: lattice, radius: 20, fill: '#ffffff',
  })
).data.nodeId
await ok('set_camera', { projectId, sceneId: cloudScene, yaw: 0.6, pitch: 0.3 })
await ok('write_on', { projectId, sceneId: cloudScene, nodeId: cloudId, start: 0, duration: 4 })
const cloud = await inkAt(projectId, [34 + 0.6, 34 + 2, 34 + 3.8])
assert.ok(
  cloud[0]! < cloud[1]! && cloud[1]! < cloud[2]!,
  `a point cloud must arrive dot by dot: ${cloud.map(pct).join(' → ')}`,
)

// ---------- 5. a spatial node with no camera still draws ----------
// Straight on, a projection is just the scene — but it must not be *nothing*,
// which is what a missing camera used to mean for a vertex-projected node.
const bareScene = (await ok('add_scene', { projectId, name: 'Bare', duration: 4, background: BG })).data
  .sceneId
await ok('add_axes3d', { projectId, sceneId: bareScene, x: 960, y: 540, size: 400, strokeWidth: 8 })
const [bare] = await inkAt(projectId, [42])
assert.ok(bare! > 0.002, `axes with no camera must still draw flat, not vanish (${pct(bare!)})`)

// ---------- 6. the errors teach ----------
const tooClose = await run('set_camera', { projectId, sceneId: spaceScene, distance: 10 })
assert.equal(tooClose.status, 400)
assert.match(tooClose.body, /wider lens/, 'a camera distance inside the diagram explains the lens')

const noZ = await run('animate', {
  projectId, sceneId: bareScene,
  nodeId: (await ok('get_scene', { projectId, sceneId: bareScene })).data.scene.nodes[0].id,
  property: 'radius', to: 5, start: 0, duration: 1,
})
assert.equal(noZ.status, 400)
assert.match(noZ.body, /does not exist on axes3d/, 'animating a property a 3D node lacks says so')

const flatNote = await ok('set_camera', { projectId, sceneId: bareScene, zoom: 1.2 })
assert.match(
  flatNote.text,
  /flat: yaw and pitch are both zero/,
  'a camera with no orbit says the scene is not being projected',
)

// ---------- 7. the agent can see an orbit without being told to look ----------
const sheet = await ok('preview_frames', { projectId })
writeFileSync(`${OUT}/check-3d-sheet.png`, Buffer.from(sheet.image!.base64, 'base64'))
const kinds = (sheet.data.moments as { kind: string; label: string }[]).filter(
  (m) => m.kind === 'camera',
)
assert.ok(kinds.some((m) => m.label.includes('yaw')), 'an orbit is a camera key moment like any other')

await ok('delete_project', { projectId, confirm: true })

console.log(
  `3d OK — occlusion ${pct(visible!)} vs ${pct(hidden!)} with only the depths swapped, ` +
    `perspective ${pct(farInk!)} → ${pct(nearInk!)}, foreshortening ${turn.map(pct).join('→')}, ` +
    `orbit angles ${angles.map(pct).join(' ')}, cloud reveal ${cloud.map(pct).join('→')}, ` +
    `bare axes ${pct(bare!)}. Distance, property and flat-camera messages all teach. ` +
    `Frames in ${OUT}/check-3d-*.png`,
)
