/** Runtime smoke test for the doc → ops → sample pipeline. Run: pnpm --filter @euclid/renderer exec tsx src/smoke.ts */
import assert from 'node:assert'
import {
  applyOps,
  emptyDoc,
  formatMoments,
  keyMoments,
  op,
  OpError,
  SCHEMA_VERSION,
  type EuclidDoc,
  type Track,
} from '@euclid/dsl'
import { pathAtProgress, pathLength, resolveNode, sampleKeyframes } from '../../../packages/engine/src/index'

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

// ---------- update_node: two ways a move can silently do nothing ----------
// Both were found in real runs. Each reports success and leaves the video
// unchanged, which is the worst combination a tool can manage.
const movable = () =>
  applyOps(emptyDoc('p2', 'move'), [
    op.addScene({ id: 'm1', name: 'S', duration: 5, background: '#101418', nodes: [] }),
    op.addNode('m1', {
      id: 'n', type: 'latex', tex: 'x', color: '#ffffff', fontSize: 64,
      position: { x: 100, y: 100 }, scale: 1, rotation: 0, opacity: 1,
      tracks: [], transitions: [],
    }),
  ])

// 1. Unknown keys. `{x, y}` is the top-level form add_latex/add_text accept,
// so it is the natural guess — and Zod used to strip it and report success.
assert.throws(
  () => applyOps(movable(), [op.updateNode('m1', 'n', { x: 960, y: 540 })]),
  (e: unknown) => e instanceof OpError && /no properties x, y/.test(e.message),
  'a patch naming properties the node does not have must be rejected, not ignored',
)
assert.deepEqual(
  (applyOps(movable(), [op.updateNode('m1', 'n', { position: { x: 960, y: 540 } })])
    .scenes[0]!.nodes[0]! as { position: unknown }).position,
  { x: 960, y: 540 },
  'the correct form still applies',
)
// Deleting an optional key with null is not an unknown key.
const named = applyOps(movable(), [op.updateNode('m1', 'n', { name: 'eq' })])
assert.doesNotThrow(() => applyOps(named, [op.updateNode('m1', 'n', { name: null })]))

// 2. A track shadows the base value. This one *does* change the document —
// get_scene shows the new position — but the keyframes win at render time,
// so nothing moves. The MCP layer warns; the reducer allows it, since
// updating the base of a tracked property is legitimate.
let tracked = applyOps(movable(), [
  op.setTrack('m1', 'n', {
    property: 'position',
    keyframes: [
      { t: 0, value: { x: 100, y: 100 }, easing: 'linear' },
      { t: 1, value: { x: 500, y: 100 }, easing: 'smooth' },
    ],
  }),
])
tracked = applyOps(tracked, [op.updateNode('m1', 'n', { position: { x: 960, y: 540 } })])
const shadowed = tracked.scenes[0]!.nodes[0]!
assert.deepEqual((shadowed as { position: unknown }).position, { x: 960, y: 540 }, 'document changed')
assert.deepEqual(resolveNode(shadowed, 0).props.position, { x: 100, y: 100 }, 'track wins at t=0')
assert.deepEqual(resolveNode(shadowed, 2).props.position, { x: 500, y: 100 }, 'track wins at t=2')

// ---------- keyMoments: the times worth looking at ----------
// Pure by design, so it is testable without a browser — which is the whole
// reason the interesting timestamps live in the document rather than being
// worked out by hand, as they were three separate times during the third
// milestone run.
const sighted: EuclidDoc = {
  schema: SCHEMA_VERSION,
  id: 'km',
  name: 'Key Moments',
  canvas: { width: 1920, height: 1080, fps: 60 },
  scenes: [
    {
      id: 's1',
      name: 'One',
      duration: 10,
      background: '#000000',
      nodes: [
        {
          id: 'eq',
          type: 'latex',
          tex: 'a^2',
          color: '#ffffff',
          fontSize: 64,
          position: { x: 0, y: 0 },
          scale: 1,
          rotation: 0,
          opacity: 1,
          tracks: [],
          transitions: [
            { type: 'texMorph', start: 2, duration: 2, toTex: 'b^2', easing: 'smooth' },
            { type: 'highlight', start: 6, duration: 2, style: 'color', color: '#e8c74a', tex: 'b' },
            { type: 'write', start: 0, duration: 1 },
          ],
        },
      ],
    },
    { id: 's2', name: 'Two', duration: 5, background: '#000000', nodes: [] },
  ],
}

const moments = keyMoments(sighted)
const kinds = moments.map((m) => m.kind)
assert.ok(kinds.includes('scene'), 'a scene opening is a moment — static layout errors live there')
assert.ok(kinds.includes('texMorph'), 'morphs are moments')
assert.ok(kinds.includes('highlight'), 'highlights are moments')
assert.ok(kinds.includes('write'), 'writes are moments')

// Times are GLOBAL, not scene-local: scene two opens after scene one's 10s.
const secondScene = moments.find((m) => m.sceneId === 's2')!
assert.ok(secondScene.t >= 10, `scene two must be lifted to global time, got ${secondScene.t}`)

// A morph is sampled across its span, so a re-layout shows as a trajectory
// rather than as one worst frame.
const morphs = moments.filter((m) => m.kind === 'texMorph').map((m) => m.t)
assert.deepEqual(morphs, [2.5, 3, 3.5], `morph sampled at 25/50/75%, got ${morphs.join(',')}`)

// The highlight is caught mid-hold, where it is at full strength.
assert.equal(moments.find((m) => m.kind === 'highlight')!.t, 7, 'highlight sampled at its middle')

// Sorted, inside the document, and never two tiles of the same instant.
for (let i = 1; i < moments.length; i++) {
  assert.ok(moments[i]!.t >= moments[i - 1]!.t, 'moments come back in time order')
  assert.ok(moments[i]!.t - moments[i - 1]!.t >= 0.05, 'near-identical times are deduped')
}
assert.ok(moments.every((m) => m.t < 15), 'no moment may fall past the end of the document')

// The cap keeps midpoints and thins the flanking samples, and it thins across
// the whole timeline — a cap must never mean "only the first half was seen".
const capped = keyMoments(sighted, { max: 4 })
assert.equal(capped.length, 4, 'the cap is respected')
assert.ok(
  capped.some((m) => m.kind === 'highlight') && capped.some((m) => m.kind === 'texMorph'),
  'capping keeps the effects, dropping only the extra samples of one',
)
assert.ok(capped.at(-1)!.t > 5, 'a capped set still reaches the back half of the video')

assert.equal(keyMoments({ ...sighted, scenes: [] }).length, 0, 'an empty document has no moments')
assert.match(formatMoments(moments), /t=\s*2\.50\s+texMorph/, 'formatting is one compact line each')

// ---------- arc-length write-on ----------
// A curve must reveal ALONG ITS LENGTH, not by a sweeping mask edge: a mask
// reveals by x-position, so a steep section appears all at once and a path
// that doubles back reveals its later half first.
// An L: 100 across, then 100 down. Half the arc length is exactly the corner.
const L = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
]
assert.equal(pathLength(L, false), 200, 'arc length is the sum of the segments')
assert.deepEqual(pathAtProgress(L, false, 0), [], 'nothing is drawn at 0')
assert.deepEqual(pathAtProgress(L, false, 1), L, 'the whole path is drawn at 1')
assert.deepEqual(
  pathAtProgress(L, false, 0.5),
  [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  'half the ARC LENGTH is the corner — not half the bounding box',
)
// The last segment is cut proportionally, or a 9-point curve reveals in 9
// visible steps instead of flowing.
assert.deepEqual(
  pathAtProgress(L, false, 0.75),
  [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }],
  'the final segment is interpolated, not snapped to a vertex',
)
// Uneven segments: the reveal must track length, so a long segment takes
// proportionally longer — which is the whole point on a plotted curve where
// steep sections have longer chords.
const uneven = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 110, y: 0 }]
assert.deepEqual(
  pathAtProgress(uneven, false, 0.5),
  [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 55, y: 0 }],
  'a long segment consumes proportionally more of the reveal',
)
// Closed paths walk the closing segment too.
const tri = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
assert.ok(
  pathLength(tri, true) > pathLength(tri, false),
  'closing the path adds the return segment to its length',
)
// Degenerate input must not divide by zero or hang.
const dot = [{ x: 5, y: 5 }, { x: 5, y: 5 }]
assert.deepEqual(pathAtProgress(dot, false, 0.5), dot, 'a zero-length path is all-or-nothing')
assert.deepEqual(pathAtProgress([{ x: 0, y: 0 }], false, 0.5), [], 'one point draws nothing')

console.log('smoke OK — reducer, sampler, morph resolution, key moments and path reveal all behave')
