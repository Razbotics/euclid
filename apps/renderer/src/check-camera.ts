/**
 * Camera (plans/006 Phase A): the scene-level transform, end to end.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-camera.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * A camera is the one feature where "the tool reported success" says almost
 * nothing: every call changes three numbers on a scene, and whether it worked
 * is entirely a question about pixels. So every claim here is measured through
 * the real capture path, using the per-tile lit fraction the preview backend
 * reports — a zoom that magnifies must light more of the frame, a pan away
 * from the subject must light less, and a node laid out past the edge of the
 * canvas must become visible when the camera goes there. PNGs are written to
 * OUT_DIR so the same frames can be looked at by eye.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'

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

/** Lit fraction at each global time, straight from the capture backend. */
async function inkAt(projectId: string, at: number[], save?: string): Promise<number[]> {
  const shot = await ok('preview_frames', { projectId, at, columns: at.length })
  if (save && shot.image) writeFileSync(`${OUT}/${save}`, Buffer.from(shot.image.base64, 'base64'))
  const ink = shot.data.ink as number[]
  assert.equal(ink.length, at.length, 'every requested frame must be measured')
  return ink
}
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

const projectId = (await ok('create_project', { name: 'Camera Check' })).data.id

// ---------- 1. zoom magnifies, and a pan can leave the subject behind ----------
const zoomScene = (await ok('add_scene', { projectId, name: 'Zoom', duration: 6 })).data.sceneId
await ok('add_shape', {
  projectId, sceneId: zoomScene, shape: 'circle', x: 960, y: 540, radius: 60, fill: '#ffffff',
})

const [flat] = await inkAt(projectId, [1])
assert.ok(flat! > 0.001, `the subject must be visible before any camera exists (${pct(flat!)})`)

await ok('set_camera', { projectId, sceneId: zoomScene, zoom: 3 })
const [zoomed] = await inkAt(projectId, [1], 'check-camera-zoom.png')
// Area goes as zoom², so 3x should be about 9x the ink. Asserted loosely at 4x:
// the point is that it magnified, not that the antialiasing agrees to a pixel.
assert.ok(
  zoomed! > flat! * 4,
  `zoom 3 must magnify the subject: ${pct(flat!)} → ${pct(zoomed!)} (expected ~9x)`,
)

// Pan the (still zoomed) camera to an empty corner. At zoom 3 the frame is
// 640x360 of scene, so a subject at (960, 540) is nowhere near it.
await ok('set_camera', { projectId, sceneId: zoomScene, x: 200, y: 200 })
const [panned] = await inkAt(projectId, [1])
assert.ok(
  panned! < flat! * 0.1,
  `panning away must leave the subject behind, not drag it along: ${pct(panned!)}`,
)

// ---------- 2. laying out past the edge of the canvas ----------
// The reason a camera exists at all: a diagram bigger than 1920x1080, read a
// piece at a time. Nothing else in the system can show this node.
const wideScene = (await ok('add_scene', { projectId, name: 'Offstage', duration: 6 })).data.sceneId
await ok('add_shape', {
  projectId, sceneId: wideScene, shape: 'circle', x: 2600, y: 540, radius: 90, fill: '#58c4dd',
})
const [offstage] = await inkAt(projectId, [6 + 1])
assert.ok(offstage! < 0.0005, `a node past the canvas edge starts invisible (${pct(offstage!)})`)

await ok('set_camera', { projectId, sceneId: wideScene, x: 2600, y: 540 })
const [reached] = await inkAt(projectId, [6 + 1], 'check-camera-offstage.png')
assert.ok(
  reached! > 0.005,
  `the camera must reach a node laid out past the canvas: ${pct(offstage!)} → ${pct(reached!)}`,
)

// ---------- 3. an animated move, through the real sampler ----------
const moveScene = (await ok('add_scene', { projectId, name: 'Push', duration: 6 })).data.sceneId
await ok('add_shape', {
  projectId, sceneId: moveScene, shape: 'circle', x: 960, y: 540, radius: 60, fill: '#ffffff',
})
await ok('move_camera', { projectId, sceneId: moveScene, zoom: 3, start: 1, duration: 3 })
const push = await inkAt(projectId, [12 + 1, 12 + 2.5, 12 + 4], 'check-camera-push.png')
assert.ok(
  push[0]! < push[1]! && push[1]! < push[2]!,
  `a push-in must grow frame by frame: ${push.map(pct).join(' → ')}`,
)
// And it holds where it landed rather than snapping back.
const [held] = await inkAt(projectId, [12 + 5.5])
assert.ok(Math.abs(held! - push[2]!) < push[2]! * 0.05, 'the move holds after its last keyframe')

// A second call chains from wherever the camera is, keeping the earlier
// keyframes — the same rule `animate` follows for nodes.
await ok('move_camera', { projectId, sceneId: moveScene, zoom: 1, start: 4.5, duration: 1 })
const chained = await inkAt(projectId, [12 + 4, 12 + 5.5])
assert.ok(chained[0]! > chained[1]! * 4, 'the second move pulls back out from where the first ended')

// ---------- 4. roll ----------
// Ink cannot see a rotating circle, so the subject is a bar longer than the
// frame is tall: rolling it upright clips it, and the lit area drops.
const rollScene = (await ok('add_scene', { projectId, name: 'Roll', duration: 6 })).data.sceneId
await ok('add_shape', {
  projectId, sceneId: rollScene, shape: 'rect', x: 960, y: 540, width: 1800, height: 200,
  fill: '#ffffff', strokeWidth: 0,
})
const [level] = await inkAt(projectId, [18 + 1])
await ok('set_camera', { projectId, sceneId: rollScene, rotation: Math.PI / 2 })
const [rolled] = await inkAt(projectId, [18 + 1], 'check-camera-roll.png')
assert.ok(
  rolled! < level! * 0.8,
  `a quarter-turn roll must stand the bar upright and clip it: ${pct(level!)} → ${pct(rolled!)}`,
)

// ---------- 5. the agent can see camera moves without being told to look ----------
const sheet = await ok('preview_frames', { projectId })
const kinds = (sheet.data.moments as { kind: string; phase: string }[]).map((m) => m.kind)
assert.ok(
  kinds.includes('camera'),
  'a camera move must be a key moment — the contact sheet is where a badly ' +
    'framed ending gets caught, and a camera has no transitions to be found by',
)
writeFileSync(`${OUT}/check-camera-sheet.png`, Buffer.from(sheet.image!.base64, 'base64'))

// ---------- 6. the errors teach, and the shadowing trap is named ----------
const noTarget = await run('move_camera', { projectId, sceneId: moveScene, start: 0, duration: 1 })
assert.equal(noTarget.status, 400)
assert.match(noTarget.body, /at least one of x, y, zoom, rotation/, 'an empty move says what to pass')

const badZoom = await run('set_camera', { projectId, sceneId: zoomScene, zoom: 500 })
assert.equal(badZoom.status, 400)
assert.match(badZoom.body, /zoom is magnification/, 'an out-of-range zoom explains the units')

const bothWays = await run('set_camera', { projectId, sceneId: zoomScene, zoom: 2, reset: true })
assert.equal(bothWays.status, 400, 'reset and a framing in one call is ambiguous, not merged')

// set_camera on a keyframed property is the update_node trap in camera form:
// the document changes, the track still wins, and nothing moves.
const shadowed = await ok('set_camera', { projectId, sceneId: moveScene, zoom: 2 })
assert.match(
  shadowed.text,
  /WARNING: zoom is keyframed/,
  'setting a keyframed camera property must say the track will win',
)
const [stillMoving] = await inkAt(projectId, [12 + 1])
assert.ok(Math.abs(stillMoving! - push[0]!) < push[0]! * 0.05, 'and it does win — the frame is unchanged')

// ---------- 7. reset ----------
await ok('set_camera', { projectId, sceneId: zoomScene, reset: true })
const [restored] = await inkAt(projectId, [1])
assert.ok(
  Math.abs(restored! - flat!) < flat! * 0.05,
  `reset must return the scene to the plain canvas frame: ${pct(flat!)} vs ${pct(restored!)}`,
)

await ok('delete_project', { projectId, confirm: true })

console.log(
  `camera OK — zoom ${pct(flat!)}→${pct(zoomed!)}, pan-away ${pct(panned!)}, ` +
    `offstage node ${pct(offstage!)}→${pct(reached!)}, push-in ${push.map(pct).join('→')}, ` +
    `roll ${pct(level!)}→${pct(rolled!)}, reset ${pct(restored!)}. ` +
    `Camera moves appear as key moments; shadowing, range and reset errors all hold. ` +
    `Frames in ${OUT}/check-camera-*.png`,
)
