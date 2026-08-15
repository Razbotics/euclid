/** Caption generation at both fidelities. Run: pnpm exec tsx src/smoke-captions.ts */
import assert from 'node:assert'
import { documentCues, toSRT, toVTT, emptyDoc, applyOps, op } from '@euclid/dsl'

let doc = emptyDoc('p', 'Caption Test')
doc = applyOps(doc, [
  op.addScene({ id: 's1', name: 'One', duration: 6, background: '#000000', nodes: [] }),
  op.addScene({ id: 's2', name: 'Two', duration: 4, background: '#000000', nodes: [] }),
  // scene 1: text only → estimated cues
  op.setNarration('s1', { text: 'First sentence here. Second sentence follows it.' }),
  // scene 2: real word timings → exact cues, scene-local (must be offset by 6s)
  op.setNarration('s2', {
    text: 'Measured words now.',
    audio: {
      assetId: 'a1',
      durationSec: 3,
      words: [
        { word: 'Measured', start: 0.0, end: 0.6 },
        { word: 'words', start: 0.6, end: 1.2 },
        { word: 'now.', start: 1.2, end: 1.8 },
      ],
    },
  }),
])

const cues = documentCues(doc)
assert.ok(cues.length >= 3, `expected >=3 cues, got ${cues.length}`)

// scene 1 cues are estimated and stay inside the scene
const est = cues.filter((c) => c.estimated)
assert.equal(est.length, 2, 'two sentences → two estimated cues')
assert.ok(est[0]!.start >= 0 && est[est.length - 1]!.end <= 6.001, 'scene 1 cues within [0,6]')

// scene 2 cue is exact and offset onto the global timeline
const exact = cues.filter((c) => !c.estimated)
assert.equal(exact.length, 1, 'one sentence of words → one cue')
assert.equal(exact[0]!.text, 'Measured words now.')
assert.ok(Math.abs(exact[0]!.start - 6.0) < 1e-6, `expected global start 6.0, got ${exact[0]!.start}`)
assert.ok(Math.abs(exact[0]!.end - 7.8) < 1e-6, `expected global end 7.8, got ${exact[0]!.end}`)

// cues never overlap or run backwards
for (let i = 1; i < cues.length; i++) {
  assert.ok(cues[i]!.start >= cues[i - 1]!.start - 1e-9, 'cues must be ordered')
  assert.ok(cues[i]!.end >= cues[i]!.start, 'cue end must follow its start')
}

// format correctness
const srt = toSRT(cues)
assert.match(srt, /^1\n00:00:00,000 --> /, 'SRT starts with cue 1 at zero')
assert.match(srt, /00:00:06,000 --> 00:00:07,800\nMeasured words now\./, 'SRT has exact scene-2 cue')
const vtt = toVTT(cues)
assert.match(vtt, /^WEBVTT\n\n/, 'VTT has header')
assert.match(vtt, /00:00:06\.000 --> 00:00:07\.800/, 'VTT uses dot milliseconds')

// A long sentence must split into balanced lines at a clause boundary, not be
// filled greedily and leave a stub. This exact sentence produced
// "…add it to both / sides." (79 chars then 6) in the Phase 5 milestone.
const LONG = 'Now the key move: take half of the x coefficient, square it, and add it to both sides.'
let long = emptyDoc('p3', 'Long')
long = applyOps(long, [
  op.addScene({ id: 'l1', name: 'Long', duration: 12, background: '#000000', nodes: [] }),
  op.setNarration('l1', {
    text: LONG,
    audio: {
      assetId: 'a3',
      durationSec: 6,
      // even 0.6s per word, so timing never forces the split — only length does
      words: LONG.split(' ').map((word, i) => ({ word, start: i * 0.6, end: i * 0.6 + 0.55 })),
    },
  }),
])
const longCues = documentCues(long)
assert.equal(longCues.length, 2, '85 chars must split into exactly two cues, not one plus a stub')
const [a, b] = [longCues[0]!.text, longCues[1]!.text]
assert.ok(a.length <= 84 && b.length <= 84, 'both cues respect the character limit')
// The real fix: neither line is a crumb. Greedy gave 79/6; balanced gives ~49/36.
assert.ok(
  Math.min(a.length, b.length) / Math.max(a.length, b.length) > 0.5,
  `cues should be balanced, got ${a.length} and ${b.length}`,
)
assert.ok(/[,;:]$/.test(a), `first cue should end at a clause boundary, got "${a}"`)
assert.equal(`${a} ${b}`, LONG, 'splitting must not lose or reorder a single word')

// Narration longer than its scene must not bleed into the next scene's cues.
// generate_narration keeps overrunning audio (rather than billing a retry),
// so the document can legitimately hold this state.
let over = emptyDoc('p2', 'Overflow')
over = applyOps(over, [
  op.addScene({ id: 'o1', name: 'Short', duration: 1, background: '#000000', nodes: [] }),
  op.addScene({ id: 'o2', name: 'Next', duration: 5, background: '#000000', nodes: [] }),
  op.setNarration('o1', {
    text: 'We rearrange both sides.',
    audio: {
      assetId: 'a2',
      durationSec: 3.2,
      words: [
        { word: 'We', start: 0, end: 0.4 },
        { word: 'rearrange', start: 0.5, end: 1.6 },
        { word: 'both', start: 1.7, end: 2.4 },
        { word: 'sides.', start: 2.5, end: 3.2 },
      ],
    },
  }),
  op.setNarration('o2', { text: 'Second scene speaks here.' }),
])
const overCues = documentCues(over)
assert.equal(overCues[0]!.end, 1, 'a cue must not outlive its 1s scene')
assert.ok(overCues[1]!.start >= overCues[0]!.end, 'clamped cue must not overlap the next scene')
// A cue starting entirely past the scene end is dropped, not clamped to zero length.
for (const c of overCues) assert.ok(c.end > c.start, 'no zero-length cues survive clamping')

// empty project → empty output, not malformed output
assert.equal(documentCues(emptyDoc('x', 'Empty')).length, 0)
assert.equal(toSRT([]), '')
assert.equal(toVTT([]), 'WEBVTT\n\n')

console.log(`captions OK — ${cues.length} cues (${exact.length} exact, ${est.length} estimated)`)
console.log(srt)
