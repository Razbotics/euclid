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

// empty project → empty output, not malformed output
assert.equal(documentCues(emptyDoc('x', 'Empty')).length, 0)
assert.equal(toSRT([]), '')
assert.equal(toVTT([]), 'WEBVTT\n\n')

console.log(`captions OK — ${cues.length} cues (${exact.length} exact, ${est.length} estimated)`)
console.log(srt)
