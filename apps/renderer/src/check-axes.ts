/**
 * Axes and ticks (roadmap Phase 4): a coordinate frame that owns the mapping,
 * and a curve that borrows it — measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-axes.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * The claim worth testing is agreement: a curve plotted into an axes node must
 * land on that node's own ticks. Lit fraction cannot see "landed on", so the
 * test frames the camera on one tick at high zoom — a few tens of pixels
 * across — where the curve either passes through or it does not.
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
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

const projectId = (await ok('create_project', { name: 'Axes Check' })).data.id

// ---------- 1. a frame draws, with ticks and numbers ----------
const scene = (await ok('add_scene', { projectId, name: 'Graph', duration: 8, background: BG })).data
  .sceneId
const axes = await ok('add_axes', {
  projectId, sceneId: scene,
  x: 360, y: 180, width: 1200, height: 720,
  xMin: -3, xMax: 3, yMin: -2, yMax: 6,
  xLabel: 'x', yLabel: 'y',
})
const axesId = axes.data.nodeId
// The response has to hand back the mapping, or plotting anything else by hand
// means deriving it a second time.
assert.match(axes.text, /Function \(0,0\) is at canvas/, 'the response reports the mapping')
assert.match(axes.text, /ticks every 1 and 2/, 'and the round steps it chose')
assert.deepEqual(axes.data.xRange, [-3, 3])
const at = (await sceneStart(projectId, scene)) + 6
const [frame] = await inkAt(projectId, [at], 'check-axes-frame.png')
assert.ok(frame! > 0.004, `axes, ticks and numbers must draw (${pct(frame!)})`)

// ---------- 2. a curve borrows the mapping ----------
// x² over x ∈ [-3,3] passes through (2,4). If the curve and the frame share a
// mapping, the curve crosses the x=2 tick at exactly y=4 — so a camera framed
// tightly there sees both. The window is ~50px of scene, far smaller than the
// error a second, hand-derived transform would produce.
await ok('plot_function', {
  projectId, sceneId: scene, expression: 'x^2', axesId, stroke: '#58c4dd', strokeWidth: 5,
})
const map = axes.data
const tickX = map.originScreen.x + 2 * map.scale.x
const valueY = map.originScreen.y - 4 * map.scale.y
await ok('set_camera', { projectId, sceneId: scene, x: tickX, y: valueY, zoom: 20 })
const [onTarget] = await inkAt(projectId, [at], 'check-axes-agreement.png')
assert.ok(
  onTarget! > 0.02,
  `the curve must pass through the point its own axes call (2, 4): nothing at ` +
    `canvas (${tickX.toFixed(0)}, ${valueY.toFixed(0)}) (${pct(onTarget!)})`,
)

// A point the curve does NOT pass through, the same distance from the tick,
// must be empty — otherwise the check above would pass on any dense drawing.
await ok('set_camera', { projectId, sceneId: scene, reset: true })
await ok('set_camera', { projectId, sceneId: scene, x: tickX, y: valueY - 260, zoom: 20 })
const [offTarget] = await inkAt(projectId, [at])
assert.ok(
  offTarget! < onTarget! * 0.25,
  `and pass nowhere near (2, 4 + 2 units): ${pct(onTarget!)} on target vs ${pct(offTarget!)} off it`,
)

// ---------- 3. an axis sits at the edge when zero is out of view ----------
const offset = (await ok('add_scene', { projectId, name: 'Offset', duration: 6, background: BG }))
  .data.sceneId
await ok('add_axes', {
  projectId, sceneId: offset,
  x: 400, y: 200, width: 1100, height: 700,
  xMin: 2, xMax: 5, yMin: 10, yMax: 40, grid: true,
})
const offsetAt = (await sceneStart(projectId, offset)) + 4
const [edged] = await inkAt(projectId, [offsetAt], 'check-axes-offset.png')
assert.ok(edged! > 0.004, `a frame whose ranges exclude zero still draws (${pct(edged!)})`)
// Framed on the left edge, where the y axis must have gone: if it had been
// drawn at function-space zero it would be far off-screen and this is empty.
await ok('set_camera', { projectId, sceneId: offset, x: 400, y: 550, zoom: 8 })
const [leftEdge] = await inkAt(projectId, [offsetAt])
assert.ok(
  leftEdge! > 0.01,
  `with zero out of range the y axis moves to the rectangle's edge (${pct(leftEdge!)})`,
)

// ---------- 4. the frame draws itself on ----------
await ok('set_camera', { projectId, sceneId: offset, reset: true })
const axes2 = (await ok('get_scene', { projectId, sceneId: offset })).data.scene.nodes[0].id
await ok('write_on', { projectId, sceneId: offset, nodeId: axes2, start: 0, duration: 4 })
const drawn = await inkAt(
  projectId,
  [offsetAt - 3.5, offsetAt - 2.5, offsetAt - 1],
  'check-axes-write.png',
)
assert.ok(
  drawn[0]! < drawn[1]! && drawn[1]! < drawn[2]!,
  `axes must draw on rather than appear: ${drawn.map(pct).join(' → ')}`,
)

// ---------- 5. the errors teach ----------
const noRect = await run('plot_function', { projectId, sceneId: scene, expression: 'x^2' })
assert.equal(noRect.status, 400)
assert.match(noRect.body, /add_axes and pass its id/, 'plotting with nothing to plot into')

const notAxes = await run('plot_function', {
  projectId, sceneId: scene, expression: 'x^2', axesId: (await ok('add_shape', {
    projectId, sceneId: scene, shape: 'circle', x: 100, y: 100, radius: 10,
  })).data.nodeId,
})
assert.equal(notAxes.status, 400)
assert.match(notAxes.body, /not an axes node/, 'and plotting into something that is not one')

const flatRange = await run('add_axes', {
  projectId, sceneId: scene, x: 0, y: 0, width: 100, height: 100,
  xMin: 1, xMax: 1, yMin: 0, yMax: 1,
})
assert.equal(flatRange.status, 400)
assert.match(flatRange.body, /two different numbers/, 'a zero-width range is refused')

await ok('delete_project', { projectId, confirm: true })

console.log(
  `axes OK — frame ${pct(frame!)}, curve on its own tick ${pct(onTarget!)} vs ${pct(offTarget!)} ` +
    `two units off it, edge-drawn axis ${pct(leftEdge!)}, write-on ${drawn.map(pct).join('→')}. ` +
    `Mapping reported, round steps chosen, and the range/type errors teach. ` +
    `Frames in ${OUT}/check-axes-*.png`,
)
