/**
 * Transcode + proxy (plans/003 §5): the editor scrubs a stand-in, the export
 * never does.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-proxy.ts
 *
 * Free. Needs `dev:api`, `dev:web` and `render-worker.ts`.
 *
 * Ground truth is **chosen, not measured off real footage**, the same way
 * check-shots.ts chooses its cuts: the source is encoded at 30fps with a fixed
 * 250-frame GOP and scene detection off, so a 6-second clip contains exactly
 * one keyframe and "the proxy seeks better" becomes a number rather than an
 * impression.
 *
 * The assertion that matters most is the last one. A proxy is only safe because
 * nothing that has to match the export can reach it, and the way to prove that
 * is not to reason about call sites but to run `preloadImages` — the real
 * function behind both the export and `preview_frames` — and weigh what it
 * hands the page.
 */
import './load-env'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { proxySize, type EuclidDoc } from '@euclid/dsl'
import { preloadImages } from './preload'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const INTERNAL = { 'x-internal-key': KEY, 'x-user-id': 'internal' }

const run = async (n: string, a: Record<string, unknown>) => {
  const r = await fetch(`${API}/api/agent/tools/${n}/execute?format=json`, {
    method: 'POST', headers: H, body: JSON.stringify(a),
  })
  return { status: r.status, body: await r.text() }
}
const ok = async (n: string, a: Record<string, unknown>) => {
  const r = await run(n, a)
  assert.equal(r.status, 200, `${n} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any }
}
const ffmpeg = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const f = spawn('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'ignore' })
    f.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`ffmpeg ${c}`))))
    f.on('error', reject)
  })
const ffprobe = (args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const f = spawn('ffprobe', ['-v', 'error', ...args])
    let out = ''
    f.stdout.on('data', (d) => (out += d))
    f.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`ffprobe ${c}`))))
    f.on('error', reject)
  })

/** Dimensions and keyframe count — the two things a proxy is supposed to change. */
async function inspect(file: string): Promise<{ width: number; height: number; keyframes: number }> {
  const dims = await ffprobe([
    '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ])
  const [width, height] = dims.trim().split(',').map(Number)
  // `-skip_frame nokey` decodes only keyframes, so the line count is the count.
  const keys = await ffprobe([
    '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file,
  ])
  return { width: width!, height: height!, keyframes: keys.trim().split('\n').filter(Boolean).length }
}

// ---------- two sources: one that needs a proxy and one that does not ----------
const dir = tmpdir()
const bigFile = join(dir, 'euclid-proxy-big.mp4')
const smallFile = join(dir, 'euclid-proxy-small.mp4')
const fetched = join(dir, 'euclid-proxy-fetched.mp4')

await ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=6:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  // The chosen ground truth: one keyframe in the whole file.
  '-g', '250', '-keyint_min', '250', '-sc_threshold', '0',
  bigFile,
])
await ffmpeg([
  '-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=2:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', smallFile,
])

const source = await inspect(bigFile)
assert.equal(source.keyframes, 1, `the source must have one keyframe, has ${source.keyframes}`)

const projectId = (await ok('create_project', { name: 'Proxy Check' })).data.id
// Uploaded as a *user*: this feature exists for footage somebody brought, and
// the user door is the one that derives `kind` from the file's own type.
const upload = async (file: string, name: string): Promise<string> => {
  const res = await fetch(`${API}/api/projects/${projectId}/assets?name=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-user-id': 'dev-user' },
    body: await readFile(file),
  })
  assert.ok(res.ok, `upload ${name} failed: ${res.status}`)
  return ((await res.json()) as { assetId: string }).assetId
}
const bigId = await upload(bigFile, 'big.mp4')
const smallId = await upload(smallFile, 'small.mp4')

// ---------- the editor works while the transcode has not happened ----------
// Asked for before the worker can possibly have finished: a proxy that is not
// there yet must serve the original rather than 404, or every upload would be
// unwatchable for as long as it takes to re-encode.
const early = await fetch(`${API}/api/assets/${bigId}?variant=proxy`, { headers: H })
assert.ok(early.ok, `a pending proxy must fall back, got ${early.status}`)
assert.equal(early.headers.get('x-euclid-variant'), 'original', 'and say which it served')

// ---------- wait for the worker: probe, then shots, then this ----------
const assetsNow = async () =>
  (await ok('list_assets', { projectId })).data.assets as {
    id: string
    proxyBytes: number | null
    proxyAt: number | null
    width: number | null
    height: number | null
  }[]
let big: (typeof settled)[number] | undefined
let smallRow: (typeof settled)[number] | undefined
let settled: Awaited<ReturnType<typeof assetsNow>> = []
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  settled = await assetsNow()
  big = settled.find((a) => a.id === bigId)
  smallRow = settled.find((a) => a.id === smallId)
  if (big?.proxyAt && smallRow?.proxyAt) break
}
assert.ok(big?.proxyAt, 'the transcode must finish within two minutes for a 6s clip')
assert.ok(smallRow?.proxyAt, 'and the small file must be settled too, not left in the queue')

// ---------- a source already comfortable to scrub is left alone ----------
assert.equal(
  smallRow!.proxyBytes,
  null,
  'a 320x240 clip gets no proxy — re-encoding it would spend worker time to save nothing',
)
const smallServed = await fetch(`${API}/api/assets/${smallId}?variant=proxy`, { headers: H })
assert.equal(
  smallServed.headers.get('x-euclid-variant'),
  'original',
  'and asking for its proxy is still safe — the caller gets the original',
)

// ---------- the proxy is what it claims to be ----------
assert.ok(big!.proxyBytes, 'a 720p source must get a proxy')
const original = await fetch(`${API}/api/assets/${bigId}`, { headers: H })
const originalBytes = Buffer.from(await original.arrayBuffer())
assert.equal(original.headers.get('x-euclid-variant'), 'original')

const proxyRes = await fetch(`${API}/api/assets/${bigId}?variant=proxy`, { headers: H })
assert.equal(proxyRes.headers.get('x-euclid-variant'), 'proxy', 'now there is one to serve')
const proxyBytes = Buffer.from(await proxyRes.arrayBuffer())
await writeFile(fetched, proxyBytes)
const proxy = await inspect(fetched)

const want = proxySize(source.width, source.height)
assert.deepEqual(
  { width: proxy.width, height: proxy.height },
  want,
  `the served proxy must be ${want.width}x${want.height}, is ${proxy.width}x${proxy.height}`,
)
assert.ok(
  proxyBytes.byteLength < originalBytes.byteLength,
  `a proxy larger than its source is not a proxy ` +
    `(${proxyBytes.byteLength} vs ${originalBytes.byteLength})`,
)

// The reason a proxy is quicker to scrub, stated as the number it actually is.
// Six seconds keyframed every second is 6; the source is 1, so a seek to 5.5s
// costs five and a half seconds of decoding there and a fraction of one here.
assert.ok(
  proxy.keyframes >= 5,
  `the proxy must be keyframed about once a second — 6s of video, ${proxy.keyframes} keyframe(s)`,
)

// ---------- and it is visible without going to the database ----------
const listed = (await ok('list_assets', { projectId })).text
assert.match(listed, new RegExp(`proxy ${want.width}x${want.height}`), `list_assets says so: ${listed}`)

// ---------- the load-bearing one: the export cannot reach it ----------
// `preloadImages` is what feeds both the export and preview_frames. Run for
// real against a page stub that keeps what it was handed, so this weighs the
// bytes that would have been drawn rather than reasoning about a URL.
const sceneId = (await ok('add_scene', { projectId, name: 'One', duration: 6 })).data.sceneId
await ok('add_video', {
  projectId, sceneId, assetId: bigId, x: 960, y: 540, width: 1280, height: 720,
})
const { doc } = (await (
  await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
).json()) as { doc: EuclidDoc }

const handed = new Map<string, string>()
const pageStub = {
  evaluate: async (_fn: unknown, arg: unknown) => {
    const [id, url] = arg as [string, string]
    handed.set(id, url)
  },
} as unknown as Page
const count = await preloadImages(pageStub, doc, { apiUrl: API, headers: INTERNAL })
assert.equal(count, 1, 'the document draws one clip')

const pushed = Buffer.from(handed.get(bigId)!.slice(handed.get(bigId)!.indexOf(',') + 1), 'base64')
assert.equal(
  pushed.byteLength,
  originalBytes.byteLength,
  `the capture path must preload the ORIGINAL (${originalBytes.byteLength} bytes); it pushed ` +
    `${pushed.byteLength}, which is ${pushed.byteLength === proxyBytes.byteLength ? 'the proxy' : 'neither file'}`,
)
assert.ok(pushed.equals(originalBytes), 'and byte-for-byte, not merely the same length')

// ---------- and the whole chain still draws ----------
// The assertion above is about bytes; this is about the clip surviving all the
// way to a picture with a proxy in existence. check-video.ts cannot cover this
// — its clip is 640x360 and therefore never gets a proxy — so without it the
// case "a proxied asset is captured" would be tested nowhere.
const sheet = await ok('preview_frames', { projectId, at: [1, 3, 5], columns: 3 })
const ink = sheet.data.ink as number[]
assert.equal(ink.length, 3, 'three tiles')
for (const [i, lit] of ink.entries()) {
  assert.ok(lit > 0.01, `tile ${i} is blank (${(lit * 100).toFixed(2)}% lit) — the clip did not draw`)
}

await ok('delete_project', { projectId, confirm: true })
await Promise.all([bigFile, smallFile, fetched].map((f) => unlink(f).catch(() => {})))
console.log(
  `proxy OK — ${source.width}x${source.height} → ${proxy.width}x${proxy.height}, ` +
    `${Math.round(originalBytes.byteLength / 1024)}KB → ${Math.round(proxyBytes.byteLength / 1024)}KB, ` +
    `keyframes ${source.keyframes} → ${proxy.keyframes} over 6s. A 320x240 clip is left alone, ` +
    `a pending proxy falls back to the original, the clip still captures ` +
    `(${ink.map((v) => `${(v * 100).toFixed(1)}%`).join('/')} lit), and preloadImages pushed the ` +
    `original byte-for-byte — so the export and preview_frames never see a proxy.`,
)
