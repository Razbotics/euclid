/**
 * Narration muxing and A/V sync, end to end.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-mux.ts
 *
 * SPENDS CREDITS (two short TTS calls) and needs ffmpeg, a running API, and
 * the web dev server.
 *
 * The project is built with a deliberately SILENT middle scene, which is what
 * makes sync objectively measurable: ffmpeg's silencedetect must find quiet
 * across exactly that scene's window, and speech must resume exactly at the
 * third scene's global start. A clip placed at the wrong offset moves that
 * boundary and fails the assertion.
 */
import './load-env'
import assert from 'node:assert'
import { execFileSync, spawnSync } from 'node:child_process'
import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { op, type EuclidDoc } from '@euclid/dsl'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const USER = 'dev-user'
const as = { 'x-internal-key': KEY, 'x-user-id': USER, 'content-type': 'application/json' }
const rendererDir = new URL('..', import.meta.url).pathname
const apiDir = new URL('../../api', import.meta.url).pathname

// Scene layout. s2 has no narration on purpose — it is the measurable gap.
const S1 = 3
const S2 = 2
const S3 = 3
const TOTAL = S1 + S2 + S3
const S3_START = S1 + S2
const TOLERANCE = 0.3 // seconds; generous enough for encoder frame alignment

function sh(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function submitOps(id: string, ops: unknown[]): Promise<void> {
  const { version } = await jsonOrThrow<{ version: number }>(
    await fetch(`${API_URL}/api/projects/${id}/doc`, { headers: as }),
    'get doc',
  )
  await jsonOrThrow(
    await fetch(`${API_URL}/api/projects/${id}/ops`, {
      method: 'POST',
      headers: as,
      body: JSON.stringify({
        id: crypto.randomUUID(),
        baseVersion: version,
        actor: { type: 'user', id: USER },
        ops,
      }),
    }),
    'submit ops',
  )
}

sh('pnpm', [
  'exec', 'wrangler', 'd1', 'execute', 'euclid', '--local', '--command',
  `INSERT INTO credits (user_id, balance) VALUES ('${USER}', 1000)
   ON CONFLICT(user_id) DO UPDATE SET balance = 1000`,
], apiDir)

const { id: projectId } = await jsonOrThrow<{ id: string }>(
  await fetch(`${API_URL}/api/projects`, {
    method: 'POST',
    headers: as,
    body: JSON.stringify({ name: 'Mux Check' }),
  }),
  'create project',
)
console.log(`project ${projectId}`)

const scene = (id: string, name: string, duration: number) =>
  op.addScene({ id, name, duration, background: '#101418', nodes: [] })

await submitOps(projectId, [
  scene('m1', 'Speaks', S1),
  scene('m2', 'Silent', S2),
  scene('m3', 'Speaks again', S3),
  // Something visible, so frames aren't uniformly blank.
  op.addNode('m1', {
    id: 't1', type: 'text', text: 'One', fill: '#ffffff', fontFamily: 'sans-serif', fontSize: 96,
    position: { x: 960, y: 540 }, scale: 1, rotation: 0, opacity: 1,
    tracks: [], transitions: [],
  }),
  op.addNode('m3', {
    id: 't3', type: 'text', text: 'Three', fill: '#ffffff', fontFamily: 'sans-serif', fontSize: 96,
    position: { x: 960, y: 540 }, scale: 1, rotation: 0, opacity: 1,
    tracks: [], transitions: [],
  }),
  op.setNarration('m1', { text: 'Consider the equation.' }),
  op.setNarration('m3', { text: 'We rearrange both sides.' }),
])

for (const sceneId of ['m1', 'm3']) {
  const gen = await jsonOrThrow<{ durationSec: number; fits: boolean }>(
    await fetch(`${API_URL}/api/projects/${projectId}/scenes/${sceneId}/narration/generate`, {
      method: 'POST', headers: as, body: '{}',
    }),
    `generate ${sceneId}`,
  )
  assert.ok(gen.fits, `${sceneId} narration (${gen.durationSec}s) must fit its scene for this check`)
  console.log(`  ${sceneId}: ${gen.durationSec.toFixed(2)}s of speech`)
}

const outPath = join(tmpdir(), `euclid-mux-check-${projectId}.mp4`)
console.log('rendering (this takes ~30s)...')
const renderLog = sh('pnpm', ['exec', 'tsx', 'src/render.ts', '--project', projectId, '--out', outPath], rendererDir)
assert.match(renderLog, /narration m1: 0s/, 'render log should place m1 at 0s')
assert.match(renderLog, new RegExp(`narration m3: ${S3_START}s`), `render log should place m3 at ${S3_START}s`)

// ---------- container ----------
const probe = JSON.parse(
  sh('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', outPath], rendererDir),
) as { streams: { codec_type: string; codec_name: string; channels?: number }[]; format: { duration: string } }

const video = probe.streams.find((s) => s.codec_type === 'video')
const audio = probe.streams.find((s) => s.codec_type === 'audio')
assert.ok(video, 'output must have a video stream')
assert.ok(audio, 'output must have an audio stream — the whole point of this phase')
assert.equal(audio.codec_name, 'aac', 'audio should be aac in an mp4')

const duration = Number(probe.format.duration)
assert.ok(
  Math.abs(duration - TOTAL) < 0.5,
  `duration ${duration}s should match the ${TOTAL}s document — audio must not extend or truncate it`,
)

// ---------- A/V sync ----------
// silencedetect reports on stderr, and -f null discards the decoded output.
// spawnSync (not execFileSync) because we need stderr, not stdout.
const detect = spawnSync(
  'ffmpeg',
  ['-i', outPath, '-af', 'silencedetect=n=-40dB:d=0.25', '-f', 'null', '-'],
  { cwd: rendererDir, encoding: 'utf8' },
)
const silenceLog = detect.stderr ?? ''
assert.match(silenceLog, /silencedetect/, 'silencedetect filter did not run')

const silences: { start: number; end: number }[] = []
let pending: number | null = null
for (const line of silenceLog.split('\n')) {
  const s = line.match(/silence_start:\s*(-?[\d.]+)/)
  const e = line.match(/silence_end:\s*(-?[\d.]+)/)
  if (s) pending = Number(s[1])
  if (e && pending !== null) {
    silences.push({ start: pending, end: Number(e[1]) })
    pending = null
  }
}
if (pending !== null) silences.push({ start: pending, end: duration })
console.log('silence windows:', silences.map((s) => `[${s.start.toFixed(2)}→${s.end.toFixed(2)}]`).join(' '))

// 1. Audio is present at the very start: m1 speaks from 0.
assert.ok(
  silences.length === 0 || silences[0]!.start > 0.2,
  `speech must start at t=0, but silence begins at ${silences[0]?.start}`,
)

// 2. The silent scene m2 [3 → 5] must be entirely quiet.
const coversM2 = silences.find((s) => s.start <= S1 + TOLERANCE && s.end >= S3_START - TOLERANCE)
assert.ok(
  coversM2,
  `no silence covering the silent scene [${S1} → ${S3_START}]; got ${JSON.stringify(silences)}`,
)

// 3. THE SYNC ASSERTION: speech resumes exactly when scene m3 begins.
assert.ok(
  Math.abs(coversM2.end - S3_START) < TOLERANCE,
  `m3 narration should start at ${S3_START}s but audio resumes at ${coversM2.end}s ` +
    `(off by ${(coversM2.end - S3_START).toFixed(3)}s) — adelay offset is wrong`,
)

await unlink(outPath).catch(() => {})
console.log(
  `mux OK — ${duration.toFixed(2)}s ${video.codec_name}+${audio.codec_name}; ` +
    `silent scene quiet across [${coversM2.start.toFixed(2)}→${coversM2.end.toFixed(2)}]; ` +
    `m3 speech resumes at ${coversM2.end.toFixed(2)}s (expected ${S3_START}s)`,
)
