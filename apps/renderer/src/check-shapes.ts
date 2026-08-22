/**
 * Canvas shapes (plans/003): a video does not have to be 16:9.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-shapes.ts
 *
 * Free. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * The ceiling used to be `maxCanvasWidth: 1920, maxCanvasHeight: 1080`, which
 * reads like a resolution budget and is really a *shape* — it made 1080x1920
 * fail the schema, so a reel could not be created at all. It is a pixel budget
 * now, and this proves the three things that had to become true: the shapes
 * exist, they draw, and one of them exports.
 */
import './load-env'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { CANVAS_PRESETS, LIMITS } from '@euclid/dsl'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(`preview backend not running at ${PREVIEW}`)
  process.exit(1)
}
const run = async (n: string, a: Record<string, unknown>) => {
  const r = await fetch(`${API}/api/agent/tools/${n}/execute?format=json`, {
    method: 'POST', headers: H, body: JSON.stringify(a),
  })
  return { status: r.status, body: await r.text() }
}
const ok = async (n: string, a: Record<string, unknown>) => {
  const r = await run(n, a)
  assert.equal(r.status, 200, `${n} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any; image?: { base64: string } }
}

// ---------- 0. every preset fits the budget it is measured against ----------
for (const [name, p] of Object.entries(CANVAS_PRESETS)) {
  assert.ok(
    p.width * p.height <= LIMITS.maxCanvasPixels,
    `${name} (${p.width}x${p.height}) must fit the pixel budget`,
  )
  assert.ok(
    p.width % 2 === 0 && p.height % 2 === 0,
    `${name} must have even dimensions — H.264 cannot encode an odd size`,
  )
  assert.ok(
    Math.max(p.width, p.height) <= LIMITS.maxCanvasDimension,
    `${name} must fit the longest-side limit`,
  )
}

// ---------- 1. the shapes can actually be created ----------
const made: { shape: string; projectId: string; w: number; h: number }[] = []
for (const shape of ['landscape', 'portrait', 'square', 'vertical_4_5'] as const) {
  const r = await ok('create_project', { name: `Shape ${shape}`, shape })
  const { width, height } = r.data.canvas as { width: number; height: number }
  const p = CANVAS_PRESETS[shape]
  assert.equal(width, p.width, `${shape} width`)
  assert.equal(height, p.height, `${shape} height`)
  assert.match(r.text, new RegExp(`${width}x${height}`), 'the response states the shape it made')
  made.push({ shape, projectId: r.data.id, w: width, h: height })
}
assert.ok(
  made.some((m) => m.h > m.w),
  'at least one preset must be taller than it is wide, which is the whole point',
)

// ---------- 2. the refusals teach ----------
const tooMany = await run('create_project', { name: 'x', width: 1920, height: 1920 })
assert.equal(tooMany.status, 400)
assert.match(tooMany.body, /budget/, 'over-budget must name the budget, not a width')
assert.match(tooMany.body, /1080x1920/, 'and say what does fit')

const odd = await run('create_project', { name: 'x', width: 1921, height: 1080 })
assert.equal(odd.status, 400)
assert.match(odd.body, /odd/, 'an odd dimension is refused before a render discovers it')
assert.match(odd.body, /H\.264/, 'and says why')

// ---------- 3. a portrait canvas draws, and exports at its own shape ----------
const portrait = made.find((m) => m.shape === 'portrait')!
const sceneId = (await ok('add_scene', {
  projectId: portrait.projectId, name: 'vertical', duration: 2, background: '#0d1117',
})).data.sceneId
await ok('add_text', {
  projectId: portrait.projectId, sceneId, text: 'shot on 9:16',
  x: portrait.w / 2, y: 300, fontSize: 72, color: '#e6edf3',
})
await ok('add_mesh', {
  projectId: portrait.projectId, sceneId, shape: 'torus',
  x: portrait.w / 2, y: portrait.h / 2, size: 300, tube: 100, segments: 40, fill: '#e8c74a',
})
await ok('set_camera', { projectId: portrait.projectId, sceneId, yaw: 0.4, pitch: 0.9 })

const shot = await ok('preview_frames', { projectId: portrait.projectId, at: [1], columns: 1 })
if (shot.image) writeFileSync(`${OUT}/check-shapes.png`, Buffer.from(shot.image.base64, 'base64'))
assert.ok((shot.data.ink as number[])[0]! > 0.05, 'a portrait frame must actually draw')

const out = `${OUT}/check-shapes-portrait.mp4`
await new Promise<void>((resolve, reject) => {
  const r = spawn(
    'pnpm',
    ['--filter', '@euclid/renderer', 'exec', 'tsx', 'src/render.ts',
     '--project', portrait.projectId, '--out', out],
    { stdio: 'ignore' },
  )
  r.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`render exited ${c}`))))
})
const probe = await new Promise<string>((resolve, reject) => {
  const f = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', out])
  let s = ''
  f.stdout.on('data', (d) => (s += d))
  f.on('close', (c) => (c === 0 ? resolve(s.trim()) : reject(new Error(`ffprobe ${c}`))))
})
assert.ok(
  probe.startsWith(`${portrait.w},${portrait.h}`),
  `the exported MP4 must be ${portrait.w}x${portrait.h}, got "${probe}". A pipeline that ` +
    `quietly re-frames to 16:9 would pass every check above and still be wrong.`,
)

for (const m of made) await ok('delete_project', { projectId: m.projectId, confirm: true })
console.log(
  `shapes OK — ${made.map((m) => `${m.shape} ${m.w}x${m.h}`).join(', ')} all create; ` +
    `over-budget and odd-dimension refusals both teach; a 9:16 scene draws and exports as ` +
    `${probe.split(',').slice(0, 2).join('x')}. Frame at ${OUT}/check-shapes.png`,
)
