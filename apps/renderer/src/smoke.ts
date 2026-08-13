/** Runtime smoke test for the doc → ops → sample pipeline. Run: pnpm --filter @euclid/renderer exec tsx src/smoke.ts */
import assert from 'node:assert'
import { applyOps, emptyDoc, op, type Track } from '@euclid/dsl'
import { resolveNode, sampleKeyframes } from '../../../packages/engine/src/index'

let doc = emptyDoc('p1', 'smoke')
doc = applyOps(doc, [
  op.addScene({ id: 's1', name: 'Scene 1', duration: 5, background: '#101418', nodes: [] }),
  op.addNode('s1', {
    id: 'c1', type: 'circle', radius: 50, fill: '#58c4dd', strokeWidth: 0,
    position: { x: 100, y: 100 }, scale: 1, rotation: 0, opacity: 1, tracks: [], transitions: [],
  }),
])
const track: Track = {
  property: 'position',
  keyframes: [
    { t: 1, value: { x: 100, y: 100 }, easing: 'linear' },
    { t: 3, value: { x: 500, y: 100 }, easing: 'linear' },
  ],
}
doc = applyOps(doc, [op.setTrack('s1', 'c1', track)])

// midpoint of a linear position track
const node = doc.scenes[0]!.nodes[0]!
const mid = resolveNode(node, 2).props.position as { x: number; y: number }
assert.equal(mid.x, 300)

// keyframe clamping at both ends
assert.deepEqual(sampleKeyframes(track.keyframes, 0), { x: 100, y: 100 })
assert.deepEqual(sampleKeyframes(track.keyframes, 99), { x: 500, y: 100 })

// bad patch must be rejected atomically (radius must stay positive)
let threw = false
try {
  applyOps(doc, [op.updateNode('s1', 'c1', { radius: -5 })])
} catch {
  threw = true
}
assert.ok(threw, 'invalid patch should throw')
assert.equal((doc.scenes[0]!.nodes[0]! as { radius: number }).radius, 50)

// texMorph resolution: before, during, after
doc = applyOps(doc, [
  op.addNode('s1', {
    id: 'eq1', type: 'latex', tex: 'a^2+b^2=c^2', color: '#ffffff', fontSize: 64,
    position: { x: 0, y: 0 }, scale: 1, rotation: 0, opacity: 1, tracks: [],
    transitions: [{ type: 'texMorph', start: 2, duration: 1, toTex: 'c=\\sqrt{a^2+b^2}', easing: 'linear' }],
  }),
])
const eq = doc.scenes[0]!.nodes[1]!
assert.equal(resolveNode(eq, 1).texMorph, null)
const during = resolveNode(eq, 2.5).texMorph
assert.ok(during && during.progress > 0.4 && during.progress < 0.6)
const after = resolveNode(eq, 4).texMorph
assert.ok(after && after.fromTex === 'c=\\sqrt{a^2+b^2}' && after.progress === 1)

console.log('smoke OK — reducer, sampler, morph resolution all behave')
