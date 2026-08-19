/**
 * The video node (plans/003 §2): a clip plays inside a scene.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-video.ts
 *
 * **Free** — the clip under test is generated locally with ffmpeg rather than
 * paid for, which also makes its content known and its colours checkable.
 * Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * The claim that has to be defended is **determinism**. A video node is the
 * first thing in this system whose pixels come from a decoder rather than from
 * arithmetic, and the purity invariant says (document, time) must always give
 * the same frame. So the headline assertion renders the same document twice in
 * two separate browsers and requires the outputs to be *bit-identical*.
 */
import './load-env'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { videoSourceTime } from '@euclid/dsl'

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
const sh = (cmd: string, args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'] })
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))))
  })

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
const pct = (v: number) => `${(v * 100).toFixed(2)}%`

// ---------- 0. the mapping is pure, and it is the part that must be ----------
const clip = { startSec: 1, sourceInSec: 2, playSec: 4, playbackRate: 1 }
assert.equal(videoSourceTime(clip, 0.5), null, 'before it starts, a clip shows nothing')
assert.equal(videoSourceTime(clip, 1), 2, 'at its start it shows sourceInSec')
assert.equal(videoSourceTime(clip, 3), 4, 'and advances with scene time')
assert.equal(videoSourceTime(clip, 5.5), null, 'past playSec it shows nothing, it does not freeze')
assert.equal(
  videoSourceTime({ ...clip, playbackRate: 2 }, 2),
  4,
  'playbackRate scales source time, not scene time',
)
assert.equal(
  videoSourceTime({ startSec: 0, sourceInSec: 0, playbackRate: 1 }, 99),
  99,
  'with no playSec it runs on, and the asset decides where it ends',
)

// ---------- a clip to test with, made rather than bought ----------
const clipPath = join(tmpdir(), 'euclid-check-video.mp4')
await sh('ffmpeg', [
  '-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath,
])

const projectId = (await ok('create_project', { name: 'Video Node Check' })).data.id
const upload = await fetch(`${API}/api/projects/${projectId}/assets?kind=video&durationSec=4`, {
  method: 'POST',
  headers: { 'content-type': 'video/mp4', 'x-internal-key': KEY, 'x-user-id': 'internal' },
  body: readFileSync(clipPath),
})
// Read once: an assertion message is evaluated eagerly, so `await res.text()`
// inside it consumes the body before `.json()` can have it.
const uploadBody = await upload.text()
assert.equal(upload.status, 200, `uploading the test clip failed: ${uploadBody}`)
const assetId = (JSON.parse(uploadBody) as { assetId: string }).assetId

// ---------- 1. it plays, and only while it should ----------
const sceneId = (await ok('add_scene', { projectId, name: 'clip', duration: 6, background: BG }))
  .data.sceneId
const added = await ok('add_video', {
  projectId, sceneId, assetId, x: 960, y: 540, width: 1000, height: 560,
  fit: 'contain', startSec: 0.5, sourceInSec: 0, playSec: 3, playbackRate: 1,
})
assert.match(added.text, /scene 0.5s→3.50s/, `the response must state when it plays: ${added.text}`)

const sheet = await ok('preview_frames', { projectId, at: [0.2, 1, 2, 3, 5], columns: 5 })
if (sheet.image) writeFileSync(`${OUT}/check-video.png`, Buffer.from(sheet.image.base64, 'base64'))
const ink = sheet.data.ink as number[]
assert.equal(ink[0], 0, `nothing before startSec (${pct(ink[0]!)})`)
assert.ok(ink[1]! > 0.01 && ink[2]! > 0.01 && ink[3]! > 0.01, `it draws while playing: ${ink}`)
assert.equal(ink[4], 0, `and nothing after it ends — a finished clip leaves, it does not freeze`)
assert.ok(
  new Set([ink[1], ink[2], ink[3]].map((v) => v!.toFixed(4))).size > 1,
  `the frames must differ over time, or it is a still: ${ink.slice(1, 4)}`,
)

// ---------- 2. the same document renders identically, twice ----------
// The purity invariant, tested where it is hardest: two browsers, two decoders,
// one document. Anything less than bit-identical would mean preview and export
// can disagree, which is the whole thing this system refuses to allow.
const a = `${OUT}/check-video-a.mp4`
const b = `${OUT}/check-video-b.mp4`
for (const out of [a, b]) {
  await sh('pnpm', ['--filter', '@euclid/renderer', 'exec', 'tsx', 'src/render.ts', '--project', projectId, '--out', out])
}
const psnr = await new Promise<string>((resolve) => {
  const p = spawn('ffmpeg', ['-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'])
  let err = ''
  p.stderr.on('data', (d) => (err += d))
  p.on('close', () => resolve(err))
})
const line = psnr.match(/PSNR[^\n]*/)?.[0] ?? ''
assert.match(
  line,
  /average:inf/,
  `two renders of one document must be bit-identical; got "${line}". Anything finite means the ` +
    `decoder is not returning the same frame for the same source second, and preview and export ` +
    `can then disagree.`,
)

// ---------- 3. the errors teach ----------
const wrongKind = await run('add_video', {
  projectId, sceneId, assetId: 'nope', x: 0, y: 0, width: 10, height: 10,
})
assert.equal(wrongKind.status, 404, 'an unknown asset is refused')

const overrun = await ok('add_video', {
  projectId, sceneId, assetId, x: 960, y: 540, width: 400, height: 300,
  startSec: 5, sourceInSec: 0, playSec: 3,
})
assert.match(
  overrun.text,
  /scene ends at 6s/,
  `a clip running past the end of its scene must say so: ${overrun.text}`,
)

await ok('delete_project', { projectId, confirm: true })
console.log(
  `video OK — the source-time mapping is pure, a clip draws only between ${pct(ink[1]!)} and ` +
    `${pct(ink[3]!)} lit and nothing outside its range, two independent renders are ` +
    `**bit-identical** (${line.trim()}), and the overrun warning names the scene end. ` +
    `Sheet at ${OUT}/check-video.png`,
)
