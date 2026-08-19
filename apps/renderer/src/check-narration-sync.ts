/**
 * Narration-anchored animation (plans/003): an effect times itself to a word.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-narration-sync.ts
 *
 * **Spends ~3 credits** (two short narrations). Needs `dev:api` with
 * ELEVENLABS_API_KEY, `dev:web`, and `render-worker.ts`.
 *
 * The assertion this exists for is the second one: an anchored effect must
 * **re-sync when the narration is regenerated**. A highlight written at 4.2s is
 * correct until someone rewrites the script, and then it is silently wrong
 * while every frame still looks plausible — the exact class of bug that has
 * cost this project two milestone runs. So the test rewrites the script so the
 * anchor word moves several seconds, and requires the marker to move with it.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { anchorTime, anchorableWords } from '@euclid/dsl'

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
const run = async (n: string, a: Record<string, unknown>, paid = false) => {
  const r = await fetch(`${API}/api/agent/tools/${n}/execute?format=json${paid ? '&paid=1' : ''}`, {
    method: 'POST', headers: H, body: JSON.stringify(a),
  })
  return { status: r.status, body: await r.text() }
}
const ok = async (n: string, a: Record<string, unknown>, paid = false) => {
  const r = await run(n, a, paid)
  assert.equal(r.status, 200, `${n} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any; image?: { base64: string } }
}
const pct = (v: number) => `${(v * 100).toFixed(3)}%`

// ---------- 0. matching is pure, and forgiving in the ways it must be ----------
const words = [
  { word: 'The', start: 0, end: 0.2 },
  { word: 'equation.', start: 1.5, end: 2 },
  { word: 'Equation', start: 3, end: 3.4 },
]
assert.equal(anchorTime(words, { word: 'equation' }), 1.5, 'punctuation must not defeat a match')
assert.equal(anchorTime(words, { word: 'EQUATION' }), 1.5, 'nor case')
assert.equal(anchorTime(words, { word: 'equation', occurrence: 2 }), 3, 'occurrences are countable')
assert.equal(anchorTime(words, { word: 'equation', offsetSec: -0.5 }), 1, 'offsets shift it')
assert.equal(anchorTime(words, { word: 'derivative' }), null, 'an unspoken word resolves to null')
assert.equal(anchorTime(undefined, { word: 'equation' }), null, 'and so does having no narration')
assert.equal(
  anchorableWords(words).filter((w) => w.word === 'equation').length,
  2,
  'both occurrences are listed for an agent to choose between',
)

const projectId = (await ok('create_project', { name: 'Narration Anchor Check' })).data.id
const sceneId = (await ok('add_scene', { projectId, name: 'anchor', duration: 12, background: '#0d1117' }))
  .data.sceneId
const nodeId = (await ok('add_latex', {
  projectId, sceneId, tex: 'e^{i\\pi}+1=0', x: 960, y: 540, fontSize: 110,
})).data.nodeId

await ok('set_narration', {
  projectId, sceneId,
  narrationText: 'Here is the most beautiful equation in all of mathematics.',
})
await ok('generate_narration', { projectId, sceneId }, true)

const first = (await ok('get_narration_timing', { projectId, sceneId, contains: 'equation' })).data
  .words[0]
assert.ok(first, 'the word must appear in the timings')
const firstAt = first.start as number

await ok('highlight', {
  projectId, sceneId, nodeId, atWord: 'equation', duration: 1.2, style: 'box', color: '#e8c74a',
})

// ---------- 1. it fires where the word is, not where a number said ----------
const before = await ok('preview_frames', { projectId, at: [firstAt + 0.4, firstAt + 3], columns: 2 })
const [onWord, offWord] = before.data.ink as number[]
assert.ok(
  onWord! > offWord! * 2,
  `the marker must be on the word (${pct(onWord!)}) and not elsewhere (${pct(offWord!)})`,
)

// ---------- 2. rewriting the script moves it — the whole point ----------
await ok('set_narration', {
  projectId, sceneId,
  narrationText:
    'Mathematicians have argued for a very long time about which formula deserves the title, ' +
    'and most of them settle on this equation.',
})
await ok('generate_narration', { projectId, sceneId }, true)
const moved = (await ok('get_narration_timing', { projectId, sceneId, contains: 'equation' })).data
  .words[0].start as number
assert.ok(
  moved > firstAt + 2,
  `the rewrite must move the word substantially (${firstAt.toFixed(2)}s → ${moved.toFixed(2)}s), ` +
    `or this test proves nothing`,
)

// The document still holds the *old* number, which is the point: it is the
// fallback, and the anchor is what the renderer actually uses.
const stored = (await ok('get_scene', { projectId, sceneId })).data.scene.nodes[0].transitions.find(
  (t: { type: string }) => t.type === 'highlight',
)
assert.equal(stored.anchor.word, 'equation', 'the anchor is stored, not resolved away')
assert.ok(
  Math.abs(stored.start - firstAt) < 0.01,
  `and the written start stays as the fallback (${stored.start} vs ${firstAt})`,
)

const after = await ok('preview_frames', { projectId, at: [firstAt + 0.4, moved + 0.4], columns: 2 })
if (after.image) writeFileSync(`${OUT}/check-narration-sync.png`, Buffer.from(after.image.base64, 'base64'))
const [atOld, atNew] = after.data.ink as number[]
assert.ok(
  atNew! > atOld! * 2,
  `after the rewrite the marker must be at the word's NEW time ${moved.toFixed(2)}s ` +
    `(${pct(atNew!)}) and gone from its old one ${firstAt.toFixed(2)}s (${pct(atOld!)}). ` +
    `Equal readings would mean the stored number won and the anchor is decoration.`,
)

// ---------- 3. the errors teach ----------
const noWhen = await run('write_on', { projectId, sceneId, nodeId })
assert.equal(noWhen.status, 400, 'an effect with neither start nor atWord is refused')
assert.match(noWhen.body, /atWord/, 'and the refusal names both ways of saying when')

const unspoken = await ok('write_on', { projectId, sceneId, nodeId, atWord: 'zebra', start: 2 })
assert.match(
  unspoken.text,
  /not in this scene/,
  `an unspoken anchor word must say so rather than silently doing nothing: ${unspoken.text}`,
)

await ok('delete_project', { projectId, confirm: true })
console.log(
  `narration sync OK — matching ignores case and punctuation, an anchored highlight lands on ` +
    `its word, and rewriting the script moved "equation" ${firstAt.toFixed(2)}s → ` +
    `${moved.toFixed(2)}s with the marker following it (${pct(atOld!)} at the old time vs ` +
    `${pct(atNew!)} at the new). Sheet at ${OUT}/check-narration-sync.png`,
)
