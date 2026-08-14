/**
 * TTS adapter: character-alignment → word timings.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-tts.ts [--live]
 *
 * Free by default — the grouping logic is pure, so it is tested against
 * recorded provider output and costs nothing. `--live` additionally makes one
 * real (tiny) synthesis call to confirm the provider still returns the shape
 * this adapter is built on.
 */
import './load-env'
import assert from 'node:assert'
import { documentCues, emptyDoc, applyOps, op } from '@euclid/dsl'
import { elevenLabsProvider, wordsFromAlignment, TtsError } from '../../api/src/tts'

// Recorded from a real /with-timestamps response for
// "Consider the equation." — abridged to the characters that matter.
const RECORDED = {
  characters: [...'Consider the equation.'],
  character_start_times_seconds: [
    0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, // Consider
    0.37, // space
    0.42, 0.45, 0.47, // the
    0.49, // space
    0.53, 0.6, 0.68, 0.75, 0.82, 0.9, 0.97, 1.02, 1.05, // equation.
  ],
  character_end_times_seconds: [
    0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.37,
    0.42,
    0.45, 0.47, 0.49,
    0.53,
    0.6, 0.68, 0.75, 0.82, 0.9, 0.97, 1.02, 1.05, 1.07,
  ],
}

const words = wordsFromAlignment(RECORDED)

assert.deepEqual(
  words.map((w) => w.word),
  ['Consider', 'the', 'equation.'],
  'characters group into words on whitespace',
)
// Trailing punctuation must stay attached: cuesFromWords breaks cues on /[.!?]$/
assert.ok(words[2]!.word.endsWith('.'), 'sentence-final punctuation stays on the word')
assert.equal(words[0]!.start, 0.0, 'first word starts at the first character')
assert.equal(words[0]!.end, 0.37, 'word end is the last character end, not the first')
assert.equal(words[2]!.end, 1.07, 'final word ends at the final character end')

// Timings must be monotonic and non-degenerate, or captions render nonsense.
for (let i = 0; i < words.length; i++) {
  assert.ok(words[i]!.end > words[i]!.start, `word ${i} must have positive duration`)
  if (i > 0) assert.ok(words[i]!.start >= words[i - 1]!.end, `word ${i} must not overlap its predecessor`)
}

// Degenerate inputs must not produce NaN timings that would poison the document.
assert.deepEqual(
  wordsFromAlignment({
    characters: [],
    character_start_times_seconds: [],
    character_end_times_seconds: [],
  }),
  [],
  'empty alignment → no words',
)
const ragged = wordsFromAlignment({
  characters: [...'hi there'],
  character_start_times_seconds: [0, 0.1], // truncated on purpose
  character_end_times_seconds: [0.1, 0.2],
})
assert.ok(
  ragged.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end)),
  'ragged arrays must never yield NaN timings',
)

// Multiple/leading/trailing spaces must not emit empty words.
const spaced = wordsFromAlignment({
  characters: [...'  a  b  '],
  character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
})
assert.deepEqual(spaced.map((w) => w.word), ['a', 'b'], 'runs of whitespace collapse')

// The payoff: these timings drive exact captions with no other change.
let doc = emptyDoc('p', 'TTS Smoke')
doc = applyOps(doc, [
  op.addScene({ id: 's1', name: 'One', duration: 5, background: '#000000', nodes: [] }),
  op.setNarration('s1', {
    text: 'Consider the equation.',
    audio: { assetId: 'a1', durationSec: 1.07, words },
  }),
])
const cues = documentCues(doc)
assert.equal(cues.length, 1, 'one sentence → one cue')
assert.equal(cues[0]!.estimated, false, 'word timings make the cue exact, not estimated')
assert.equal(cues[0]!.text, 'Consider the equation.')

// Empty text is rejected before any network call (and so before any charge).
await assert.rejects(
  () => elevenLabsProvider('unused-key').synthesize({ text: '   ' }),
  (e: unknown) => e instanceof TtsError && e.code === 'empty_text',
  'blank narration must fail fast, not hit the provider',
)

console.log(`tts adapter OK — ${words.length} words derived, cue is exact (offline)`)

// ---------- opt-in live check ----------

if (process.argv.includes('--live')) {
  const key = process.env.ELEVENLABS_API_KEY
  assert.ok(key, 'ELEVENLABS_API_KEY missing — cannot run --live')

  const result = await elevenLabsProvider(key).synthesize({ text: 'We rearrange both sides.' })
  assert.equal(result.mime, 'audio/mpeg')
  assert.ok(result.audio.byteLength > 1000, `expected real audio, got ${result.audio.byteLength} bytes`)
  assert.ok(result.durationSec > 0.5, `implausible duration ${result.durationSec}s`)
  assert.deepEqual(
    result.words.map((w) => w.word),
    ['We', 'rearrange', 'both', 'sides.'],
    'live provider still groups into the expected words',
  )
  assert.ok(
    Math.abs(result.words.at(-1)!.end - result.durationSec) < 0.001,
    'reported duration matches the last word end',
  )
  // Proves we decoded real audio, not base64 of an error blob. ElevenLabs
  // prefixes the frames with an ID3v2 tag, so accept either that or a bare
  // frame sync (0xFF Ex/Fx) rather than assuming one layout.
  const head = new Uint8Array(result.audio.slice(0, 3))
  const isID3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33
  const isFrameSync = head[0] === 0xff && (head[1]! & 0xe0) === 0xe0
  assert.ok(
    isID3 || isFrameSync,
    `decoded bytes are not mp3 (got ${[...head].map((b) => b.toString(16)).join(' ')})`,
  )

  console.log(
    `live OK — ${result.durationSec.toFixed(3)}s, ${result.words.length} words, ` +
      `${(result.audio.byteLength / 1024).toFixed(0)}KiB mp3`,
  )
}
