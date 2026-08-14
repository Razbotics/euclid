/**
 * Narration generation end-to-end against a running API.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-narration.ts
 *
 * SPENDS CREDITS — makes two real TTS calls (deliberately short ones).
 * Proves the whole 3c path: pricing, up-front debit, synthesis, asset storage,
 * the system op reaching the document, caption upgrade, the overflow warning,
 * and that refused requests charge nothing.
 *
 * `--refund` instead asserts the provider-failure path, and must be run
 * against an API whose TTS key is deliberately broken:
 *   1. put a junk ELEVENLABS_API_KEY in .env.local
 *   2. node scripts/sync-env.mjs && restart the api worker
 *   3. pnpm --filter @euclid/renderer exec tsx src/check-narration.ts --refund
 *   4. remove the line, re-sync, restart
 * Costs nothing — the provider rejects the call before doing any work.
 */
import './load-env'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { op, ttsCost, type EuclidDoc } from '@euclid/dsl'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const USER = 'dev-user'
const as = { 'x-internal-key': KEY, 'x-user-id': USER, 'content-type': 'application/json' }

/** Credits have no grant endpoint (Stripe is the only way in), so seed via D1. */
function setBalance(balance: number): void {
  execFileSync(
    'pnpm',
    [
      'exec', 'wrangler', 'd1', 'execute', 'euclid', '--local', '--command',
      `INSERT INTO credits (user_id, balance) VALUES ('${USER}', ${balance})
       ON CONFLICT(user_id) DO UPDATE SET balance = ${balance}`,
    ],
    { cwd: new URL('../../api', import.meta.url).pathname, stdio: 'pipe' },
  )
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const balance = async (): Promise<number> =>
  (await jsonOrThrow<{ balance: number }>(
    await fetch(`${API_URL}/api/billing/balance`, { headers: as }),
    'balance',
  )).balance

const getDoc = async (id: string): Promise<{ doc: EuclidDoc; version: number }> =>
  jsonOrThrow(await fetch(`${API_URL}/api/projects/${id}/doc`, { headers: as }), 'get doc')

async function submitOps(id: string, ops: unknown[]): Promise<void> {
  const { version } = await getDoc(id)
  const res = await fetch(`${API_URL}/api/projects/${id}/ops`, {
    method: 'POST',
    headers: as,
    body: JSON.stringify({
      id: crypto.randomUUID(),
      baseVersion: version,
      actor: { type: 'user', id: USER },
      ops,
    }),
  })
  await jsonOrThrow(res, 'submit ops')
}

const generate = (id: string, sceneId: string, body: unknown = {}) =>
  fetch(`${API_URL}/api/projects/${id}/scenes/${sceneId}/narration/generate`, {
    method: 'POST',
    headers: as,
    body: JSON.stringify(body),
  })

interface GenResult {
  assetId: string
  cost: number
  durationSec: number
  words: number
  sceneDuration: number
  fits: boolean
  warning?: string
}

setBalance(1000)

const { id: projectId } = await jsonOrThrow<{ id: string }>(
  await fetch(`${API_URL}/api/projects`, {
    method: 'POST',
    headers: as,
    body: JSON.stringify({ name: 'Narration Check' }),
  }),
  'create project',
)

// ---------- provider-failure mode ----------
if (process.argv.includes('--refund')) {
  await submitOps(projectId, [
    op.addScene({ id: 'f1', name: 'Fails', duration: 8, background: '#101418', nodes: [] }),
    op.setNarration('f1', { text: 'This synthesis is expected to fail.' }),
  ])
  const start = await balance()
  const res = await generate(projectId, 'f1')
  assert.equal(res.status, 502, `expected provider failure, got ${res.status}`)
  const body = (await res.json()) as { error: string; refunded: number; detail: string }
  assert.equal(body.error, 'tts_failed')
  assert.ok(body.refunded > 0, 'response must state what was refunded')
  assert.equal(await balance(), start, 'a failed synthesis must leave the balance exactly as it was')

  // The document must not reference audio that was never stored.
  const { doc } = await getDoc(projectId)
  assert.equal(
    doc.scenes.find((s) => s.id === 'f1')!.narration?.audio,
    undefined,
    'a failed synthesis must not write audio into the document',
  )
  console.log(`refund OK — charged ${body.refunded} then refunded it; balance unchanged at ${start}`)
  process.exit(0)
}

// s1 is generously long so the speech fits; s2 is short so it must overflow.
const FITS_TEXT = 'Consider the equation.'
await submitOps(projectId, [
  op.addScene({ id: 's1', name: 'Fits', duration: 8, background: '#101418', nodes: [] }),
  op.addScene({ id: 's2', name: 'Overflows', duration: 1, background: '#101418', nodes: [] }),
  op.addScene({ id: 's3', name: 'No script', duration: 3, background: '#101418', nodes: [] }),
  op.setNarration('s1', { text: FITS_TEXT }),
  op.setNarration('s2', { text: 'We rearrange both sides and simplify the result carefully.' }),
])

// ---------- 1. text with no script is refused before any charge ----------
const before = await balance()
const noText = await generate(projectId, 's3')
assert.equal(noText.status, 400, 'scene without narration text → 400')
assert.equal(await balance(), before, 'a refused request must not charge')

// ---------- 2. unknown scene ----------
assert.equal((await generate(projectId, 'nope')).status, 404, 'unknown scene → 404')

// ---------- 3. the happy path ----------
const expectedCost = ttsCost(FITS_TEXT)
const fit = await jsonOrThrow<GenResult>(await generate(projectId, 's1'), 'generate s1')

assert.equal(fit.cost, expectedCost, 'charged price must match the published ttsCost()')
assert.equal(await balance(), before - expectedCost, 'balance falls by exactly the quoted cost')
assert.ok(fit.durationSec > 0.5, `implausible duration ${fit.durationSec}`)
assert.ok(fit.words >= 3, `expected word timings, got ${fit.words}`)
assert.equal(fit.fits, true, 'short speech fits an 8s scene')
assert.equal(fit.warning, undefined, 'a fitting scene carries no warning')

// The op really reached the document (not just the HTTP response).
const { doc } = await getDoc(projectId)
const s1 = doc.scenes.find((s) => s.id === 's1')!
assert.ok(s1.narration?.audio, 'narration.audio written into the document')
assert.equal(s1.narration.audio.assetId, fit.assetId, 'document points at the stored asset')
assert.equal(s1.narration.audio.words?.length, fit.words, 'word timings persisted')
assert.ok(
  s1.narration.audio.words!.every((w) => Number.isFinite(w.start) && w.end > w.start),
  'persisted timings are finite and ordered',
)

// The audio is real and fetchable through the asset route.
const audio = await fetch(`${API_URL}/api/assets/${fit.assetId}`, { headers: as })
assert.ok(audio.ok, `asset fetch failed: ${audio.status}`)
assert.equal(audio.headers.get('content-type'), 'audio/mpeg')
const bytes = new Uint8Array(await audio.arrayBuffer())
assert.ok(bytes.byteLength > 1000, `expected real audio, got ${bytes.byteLength} bytes`)
const isID3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33
const isFrameSync = bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0
assert.ok(isID3 || isFrameSync, 'stored asset is not mp3')

// Captions sharpen from estimated to exact with no migration.
const cues = await jsonOrThrow<{ cues: { estimated: boolean }[] }>(
  await fetch(`${API_URL}/api/projects/${projectId}/captions?format=json`, { headers: as }),
  'captions',
)
const s1Cues = cues.cues.filter((q) => !q.estimated)
assert.ok(s1Cues.length >= 1, 'generated narration yields exact cues')

// ---------- 4. overflow reports rather than rejects ----------
const overflowBefore = await balance()
const over = await jsonOrThrow<GenResult>(await generate(projectId, 's2'), 'generate s2')
assert.equal(over.fits, false, '58 characters of speech cannot fit a 1s scene')
assert.ok(over.warning?.includes('update_scene'), 'warning names the tool that fixes it')
assert.ok(over.warning?.includes('s2'), 'warning names the scene')
assert.equal(await balance(), overflowBefore - over.cost, 'overflow still charges — the audio is real')

// Crucially, the audio was kept: the user paid for it, so it is in the document.
const { doc: doc2 } = await getDoc(projectId)
const s2 = doc2.scenes.find((s) => s.id === 's2')!
assert.ok(s2.narration?.audio?.assetId, 'overflowing narration is still written to the document')

// And the documented remedy actually works.
await submitOps(projectId, [op.updateScene('s2', { duration: over.durationSec + 0.5 })])
const { doc: doc3 } = await getDoc(projectId)
assert.ok(
  doc3.scenes.find((s) => s.id === 's2')!.duration > over.durationSec,
  'update_scene can extend the scene to fit',
)

// ---------- 5. insufficient credits refuses before spending ----------
setBalance(0)
const broke = await generate(projectId, 's1')
assert.equal(broke.status, 402, 'no credits → 402')
const brokeBody = (await broke.json()) as { required: number; balance: number }
assert.ok(brokeBody.required > 0, '402 tells the caller what it would cost')
assert.equal(await balance(), 0, 'a refused request leaves the balance untouched')

setBalance(1000)
console.log(
  `narration OK — s1 ${fit.durationSec.toFixed(2)}s/${fit.words} words for ${fit.cost} credits (fits); ` +
    `s2 ${over.durationSec.toFixed(2)}s in a 1s scene warned and kept; ` +
    `captions exact; 400/402/404 paths charge nothing`,
)
