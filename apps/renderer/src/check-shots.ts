/**
 * Shot detection (plans/003 §5): where a video cuts.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-shots.ts
 *
 * Free. Needs `dev:api` and `render-worker.ts` (no renderer — nothing is drawn).
 *
 * Built against **known** ground truth rather than real footage: three
 * visually distinct two-second clips concatenated, so the cuts are at exactly
 * 2.0s and 4.0s and "close enough" is measurable. A detector tested on footage
 * whose cuts nobody knows can only be eyeballed.
 */
import './load-env'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }

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

// ---------- a video whose cuts we chose ----------
const dir = tmpdir()
const parts = ['red', 'blue'].map((c, i) => join(dir, `euclid-shot-${i}.mp4`))
const third = join(dir, 'euclid-shot-2.mp4')
const listFile = join(dir, 'euclid-shot-list.txt')
const cuts = join(dir, 'euclid-shot-cuts.mp4')
const single = join(dir, 'euclid-shot-single.mp4')

await ffmpeg(['-f', 'lavfi', '-i', `color=c=red:s=320x240:d=2:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', parts[0]!])
await ffmpeg(['-f', 'lavfi', '-i', `color=c=blue:s=320x240:d=2:r=30`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', parts[1]!])
await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=320x240:d=2:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', third])
await writeFile(listFile, [...parts, third].map((p) => `file '${p}'`).join('\n'))
await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', cuts])
// A single continuous take, to prove the detector does not invent cuts.
await ffmpeg(['-f', 'lavfi', '-i', 'color=c=green:s=320x240:d=4:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', single])

const projectId = (await ok('create_project', { name: 'Shot Detection Check' })).data.id
/**
 * Uploaded as a **user**, not with the internal key. That is the path this
 * feature exists for — and the two doors behave differently on purpose: an
 * internal producer is trusted about `kind` and defaults to audio, while a
 * user's `kind` comes from their file's own type. Using the wrong door here
 * filed an mp4 as audio and the first run of this check failed with
 * "is audio, not a video", which is the guard working.
 */
const upload = async (file: string, name: string): Promise<string> => {
  const res = await fetch(`${API}/api/projects/${projectId}/assets?name=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'video/mp4', 'x-user-id': 'dev-user' },
    body: await readFile(file),
  })
  assert.ok(res.ok, `upload ${name} failed: ${res.status}`)
  return ((await res.json()) as { assetId: string }).assetId
}
const cutsId = await upload(cuts, 'cuts.mp4')
const singleId = await upload(single, 'single.mp4')

// ---------- "not looked at yet" is not "no cuts" ----------
const early = await ok('get_shots', { projectId, assetId: cutsId })
if (early.data.pending) {
  assert.match(
    early.text,
    /not the same as/i,
    'while pending it must distinguish itself from "no cuts found"',
  )
}

// The worker probes and then watches; both lag the upload deliberately.
let shots: number[] | null = null
for (let i = 0; i < 60 && shots === null; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const s = await ok('get_shots', { projectId, assetId: cutsId })
  if (!s.data.pending) shots = s.data.shots as number[]
}
assert.ok(shots, 'shot detection must finish within two minutes for a 6s clip')

// ---------- the cuts are where we put them ----------
assert.equal(shots!.length, 2, `expected 2 cuts, got ${shots!.length}: ${shots!.join(', ')}`)
for (const [i, expected] of [2, 4].entries()) {
  assert.ok(
    Math.abs(shots![i]! - expected) < 0.15,
    `cut ${i} should be at ${expected}s, detected ${shots![i]!.toFixed(3)}s`,
  )
}

// ---------- the segments between them are what a caller picks from ----------
const detail = await ok('get_shots', { projectId, assetId: cutsId })
const segments = detail.data.segments as { from: number; to: number }[]
assert.equal(segments.length, 3, `two cuts bound three segments, got ${segments.length}`)
assert.ok(Math.abs(segments[0]!.from - 0) < 0.01, 'the first segment starts at zero')
assert.ok(Math.abs(segments[2]!.to - 6) < 0.15, 'the last segment ends at the duration')
assert.match(detail.text, /→/, 'and the text names the ranges rather than only the cuts')

// ---------- a continuous take has no cuts, and says so plainly ----------
let takeShots: number[] | null = null
for (let i = 0; i < 60 && takeShots === null; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const s = await ok('get_shots', { projectId, assetId: singleId })
  if (!s.data.pending) takeShots = s.data.shots as number[]
}
assert.equal(takeShots!.length, 0, `a continuous take must have no cuts, got ${takeShots!.join(', ')}`)
const takeText = (await ok('get_shots', { projectId, assetId: singleId })).text
assert.match(takeText, /continuous take/, `and say so: "${takeText}"`)

// ---------- the errors teach ----------
const assets = (await ok('list_assets', { projectId })).data.assets as { id: string; kind: string }[]
void assets
const notVideo = await run('get_shots', { projectId, assetId: 'nope' })
assert.equal(notVideo.status, 404, 'an unknown asset is refused')

await ok('delete_project', { projectId, confirm: true })
await Promise.all([...parts, third, listFile, cuts, single].map((f) => unlink(f).catch(() => {})))
console.log(
  `shots OK — cuts detected at ${shots!.map((t) => t.toFixed(2)).join(', ')}s against a ground ` +
    `truth of 2.00, 4.00; three segments bounded correctly; a continuous take reports none.`,
)
