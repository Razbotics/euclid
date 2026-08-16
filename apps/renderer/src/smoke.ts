/** Runtime smoke test for the doc → ops → sample pipeline. Run: pnpm --filter @euclid/renderer exec tsx src/smoke.ts */
import assert from 'node:assert'
import {
  applyOps,
  cellCenter,
  cellsInRange,
  defaultCamera,
  describeRange,
  gridSize,
  rangeBounds,
  resolveRange,
  emptyDoc,
  formatMoments,
  keyMoments,
  op,
  OpError,
  outlineDoc,
  SCHEMA_VERSION,
  evaluateExpression,
  samplePlot,
  type EuclidDoc,
  type Track,
} from '@euclid/dsl'
import {
  columnMajorRank,
  isFlatCamera,
  matchByKey,
  project3,
  pathAtProgress,
  pathLength,
  resolveCamera,
  staggerAlphas,
  writeGlyphAlphas,
  resolveNode,
  resolveScene,
  sampleKeyframes,
} from '../../../packages/engine/src/index'

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

// ---------- expression evaluation ----------
// Its own grammar rather than anything reaching the JS evaluator, so it is
// pure by construction: nothing outside the whitelist is reachable.
assert.equal(evaluateExpression('x^2', 3), 9)
assert.equal(evaluateExpression('2*x + 1', 4), 9)
assert.equal(evaluateExpression('-x^2', 3), -9, 'unary minus binds looser than the power')
assert.equal(evaluateExpression('(2+3)*x', 2), 10, 'parentheses group')
assert.equal(evaluateExpression('2^3^2', 0), 512, 'exponentiation is right-associative')
assert.equal(evaluateExpression('x**2', 5), 25, '** is accepted as a synonym for ^')
assert.ok(Math.abs(evaluateExpression('sin(pi/2)', 0) - 1) < 1e-12, 'functions and constants')
assert.equal(evaluateExpression('sqrt(abs(-x))', 16), 4, 'calls nest')
// The point of a whitelist is that everything else is refused, loudly.
for (const bad of ['Math.random()', 'x; process.exit(1)', 'window', 'foo(x)', '2x']) {
  assert.throws(() => evaluateExpression(bad, 1), `"${bad}" must be refused`)
}
// Implicit multiplication is refused rather than guessed — a caller who typo'd
// must not get a silently different curve.
assert.throws(() => evaluateExpression('2x', 1), /explicitly/, 'and the error names the fix')

// ---------- plot mapping ----------
// The mapping is what run 4 got wrong by hand: it is easy to sample a function
// and hard to land it on the canvas the right way up.
const plot = samplePlot({
  expression: 'x^2',
  domain: [0, 2],
  rect: { x: 100, y: 200, width: 400, height: 300 },
  samples: 5,
})
assert.equal(plot.points.length, 5)
assert.deepEqual(plot.range.map((v) => Math.round(v * 100) / 100), [-0.2, 4.2], 'range is fitted with padding')
// Canvas y grows DOWNWARD, so a larger function value must be a smaller y.
assert.ok(
  plot.points.at(-1)!.y < plot.points[0]!.y,
  'the top of the parabola must be higher on screen, not lower',
)
// x maps left to right across the rectangle.
assert.equal(Math.round(plot.points[0]!.x), 100, 'the domain starts at the left edge')
assert.equal(Math.round(plot.points.at(-1)!.x), 500, 'and ends at the right edge')
// The reported mapping must actually reproduce the points, or a caller placing
// a dot "on the curve" would find it beside the curve.
const sampleAtOne = plot.points[2]!
assert.ok(
  Math.abs(plot.originScreen.x + 1 * plot.scale.x - sampleAtOne.x) < 1e-9 &&
    Math.abs(plot.originScreen.y - 1 * plot.scale.y - sampleAtOne.y) < 1e-9,
  'originScreen + scale must reproduce a sampled point exactly',
)
// Fitted axes differ per axis by design; uniform forces them equal.
assert.ok(plot.scale.x !== plot.scale.y, 'a fitted plot fills the rectangle')
const round = samplePlot({
  expression: 'x^2', domain: [0, 2], rect: { x: 0, y: 0, width: 400, height: 300 }, uniform: true,
})
assert.equal(round.scale.x, round.scale.y, 'uniform keeps the axes in proportion')

// Undefined points are skipped and counted, not allowed to break the curve.
const withHoles = samplePlot({
  expression: 'sqrt(x)', domain: [-1, 1], rect: { x: 0, y: 0, width: 100, height: 100 }, samples: 21,
})
assert.ok(withHoles.dropped > 0, 'sqrt of a negative is dropped')
assert.ok(withHoles.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)))
assert.throws(
  () => samplePlot({ expression: 'sqrt(x)', domain: [-4, -1], rect: { x: 0, y: 0, width: 10, height: 10 } }),
  /undefined almost everywhere/,
  'a function undefined across the whole domain is an error, not an empty path',
)
// A constant has no extent to fit; it must land mid-rectangle, not divide by zero.
const flat = samplePlot({
  expression: '3', domain: [0, 1], rect: { x: 0, y: 0, width: 100, height: 100 },
})
assert.ok(flat.points.every((p) => Math.abs(p.y - 50) < 1e-9), 'a constant sits mid-rectangle')

// ---------- camera ----------
// A scene-level transform, sampled by the same keyframe machinery as a node.
// Everything here is the pure half of it; check-camera.ts proves the pixels.
const canvas = { width: 1920, height: 1080, fps: 60 } as const
let shot = applyOps(emptyDoc('cam', 'Camera'), [
  op.addScene({ id: 'cs', name: 'Framed', duration: 6, background: '#101418', nodes: [] }),
])

// No camera means no transform at all, not an identity camera — the stage has
// to be able to tell "framed on the canvas" from "not framed".
assert.equal(resolveScene(shot.scenes[0]!, 0).camera, null, 'a scene without a camera resolves none')
assert.deepEqual(
  defaultCamera(canvas),
  { position: { x: 960, y: 540 }, zoom: 1, rotation: 0, yaw: 0, pitch: 0, distance: 2000, tracks: [] },
  'the default camera is the canvas centre at zoom 1, flat — adding one must move nothing',
)

shot = applyOps(shot, [
  op.setCamera('cs', {
    ...defaultCamera(canvas),
    zoom: 2,
    // Deliberately out of order: the reducer sorts, exactly as track.set does,
    // or the sampler would interpolate backwards through them.
    tracks: [
      {
        property: 'position',
        keyframes: [
          { t: 4, value: { x: 1400, y: 540 }, easing: 'linear' },
          { t: 2, value: { x: 400, y: 540 }, easing: 'linear' },
        ],
      },
    ],
  }),
])
const framed = shot.scenes[0]!
assert.deepEqual(
  framed.camera!.tracks[0]!.keyframes.map((k) => k.t),
  [2, 4],
  'camera keyframes are sorted on the way in',
)
assert.deepEqual(resolveCamera(framed, 3)!.position, { x: 900, y: 540 }, 'a camera pan interpolates')
assert.equal(resolveCamera(framed, 3)!.zoom, 2, 'an untracked property keeps its base value')
// Same shadowing rule as nodes: where a track exists it wins, base or not.
assert.deepEqual(resolveCamera(framed, 0)!.position, { x: 400, y: 540 }, 'before the first keyframe, the track still wins')

// The schema bounds the base zoom; a keyframe can only be bounded at sample
// time, and a zoom of 0 collapses the scene into a blank frame forever after.
const collapsed = {
  ...framed,
  camera: {
    ...defaultCamera(canvas),
    tracks: [{ property: 'zoom' as const, keyframes: [{ t: 0, value: 0, easing: 'linear' as const }] }],
  },
}
assert.ok(resolveCamera(collapsed, 1)!.zoom > 0, 'a zero-zoom keyframe is clamped, not rendered')

assert.throws(
  () => applyOps(shot, [op.setCamera('cs', { ...defaultCamera(canvas), zoom: 0 })]),
  'a zero base zoom is refused outright',
)
assert.equal(
  applyOps(shot, [op.clearCamera('cs')]).scenes[0]!.camera,
  undefined,
  'clearCamera removes it entirely, tracks and all',
)

// A camera move is a key moment: it re-frames every node at once, and where it
// settles is the composition that has to be right.
const camMoments = keyMoments(shot).filter((m) => m.kind === 'camera')
assert.ok(camMoments.length >= 2, 'a camera move is sampled mid-move and where it settles')
assert.ok(
  camMoments.some((m) => m.phase === 'settled' && Math.abs(m.t - 4) < 1e-9),
  'the settled sample lands on the closing keyframe',
)
assert.match(camMoments[0]!.label, /camera position → \(\d+,\d+\)/, 'the tile label names the target')
// A held camera is not a move — two identical keyframes must not earn tiles.
const held = applyOps(shot, [
  op.setCamera('cs', {
    ...defaultCamera(canvas),
    tracks: [
      {
        property: 'zoom',
        keyframes: [
          { t: 0, value: 2, easing: 'linear' },
          { t: 3, value: 2, easing: 'linear' },
        ],
      },
    ],
  }),
])
assert.equal(keyMoments(held).filter((m) => m.kind === 'camera').length, 0, 'a hold is not a move')

// The outline is the agent's main read; a camera that re-frames everything and
// does not appear in it would make every node coordinate misleading.
assert.match(outlineDoc(shot), /cam@\(960,540\) zoom=2 cam-tracks\[position\]/, 'the outline shows the camera')
assert.doesNotMatch(outlineDoc(applyOps(shot, [op.clearCamera('cs')])), /cam@/, 'and says nothing when there is none')

// ---------- structured primitives: the grid ----------
// Layout is deliberately unmeasured — fixed pitch, contents centred — so all of
// it is checkable without a browser, which is the point of keeping it here.
const spec = { rows: 2, cols: 3, cellWidth: 100, cellHeight: 60 }
assert.deepEqual(gridSize(spec), { width: 300, height: 120 })
assert.deepEqual(cellCenter(spec, 0, 0), { x: -100, y: -30 }, 'the grid is centred on the node')
assert.deepEqual(cellCenter(spec, 1, 2), { x: 100, y: 30 })
assert.deepEqual(cellCenter({ ...spec, rows: 1, cols: 1 }, 0, 0), { x: 0, y: 0 }, 'a 1x1 sits at the origin')

// `{}` is everything; one axis omitted means all of that axis.
assert.deepEqual(cellsInRange(spec, undefined), [0, 1, 2, 3, 4, 5], 'no range is every cell')
assert.deepEqual(cellsInRange(spec, { rows: [1, 1] }), [3, 4, 5], 'a row is contiguous in row-major order')
assert.deepEqual(cellsInRange(spec, { cols: [2, 2] }), [2, 5], 'a column strides')
assert.deepEqual(cellsInRange(spec, { rows: [0, 0], cols: [1, 1] }), [1], 'both axes is one cell')
// A backwards span is the same span read the other way, not an empty one.
assert.deepEqual(cellsInRange(spec, { rows: [1, 0] }), [0, 1, 2, 3, 4, 5], 'ends are normalised')
// Out of range must select nothing rather than quietly snapping to the edge:
// a marker drawn on the wrong row looks like it worked.
assert.deepEqual(cellsInRange(spec, { rows: [9, 9] }), [], 'a row that does not exist selects nothing')
assert.equal(resolveRange(spec, { cols: [7, 8] }), null, 'and resolves to null, not to the last column')
assert.deepEqual(rangeBounds(spec, { rows: [0, 0] }), { x: 0, y: -30, width: 300, height: 60 })
assert.equal(describeRange({ rows: [1, 1], cols: [2, 2] }), 'cell (1,2)')
assert.equal(describeRange({ rows: [0, 2] }), 'rows 0–2')
assert.equal(describeRange(undefined), 'all cells')

// ---------- stagger: one curve, three callers ----------
// Extracted from writeGlyphAlphas, which had this maths with `glyph` welded on.
const early = staggerAlphas(4, 0.3)
assert.ok(early[0]! > early[1]! && early[1]! >= early[2]!, 'earlier elements lead')
assert.deepEqual(staggerAlphas(4, 0), [0, 0, 0, 0], 'nothing is shown at 0')
assert.deepEqual(staggerAlphas(4, 1), [1, 1, 1, 1], 'everything is shown at 1')
assert.deepEqual(staggerAlphas(1, 0.4), [0.4], 'a single element is just the progress')
assert.deepEqual(staggerAlphas(0, 0.5), [], 'no elements, no alphas')
// The order is the caller's: a column-major rank reveals down the columns of a
// row-major grid, which is what a matrix built from column vectors wants.
const colRank = columnMajorRank(2, 3)
assert.deepEqual(colRank, [0, 2, 4, 1, 3, 5], 'row-major index → column-major arrival')
const byColumn = staggerAlphas(6, 0.3, { rank: colRank })
assert.ok(byColumn[3]! > byColumn[1]!, 'the cell below arrives before the one to the right')
// The glyph reveal is now this function, so it must not have changed.
assert.deepEqual(writeGlyphAlphas(5, 0.42), staggerAlphas(5, 0.42), 'the glyph reveal is the same curve')

// ---------- matching by a key: glyphs, then cells ----------
const cellsA = ['a', 'b', 'c', 'd']
const cellsB = ['a', 'x', 'c', 'd']
const cellMatch = matchByKey(cellsA, cellsB, (c) => c)
assert.equal(cellMatch.pairs.length, 3, 'three cells survive a single replacement')
assert.deepEqual(cellMatch.removed, [1], 'and the replaced one leaves')
assert.deepEqual(cellMatch.added, [1], 'as the new one arrives')
// Order-preserving, exactly as for glyphs: a matched cell must never cross
// another, or a re-stated matrix reads as chaos rather than as an edit.
const swapped = matchByKey(['p', 'q'], ['q', 'p'], (c) => c)
assert.equal(swapped.pairs.length, 1, 'a swap keeps one anchor rather than crossing both over')

// ---------- a matrix restating itself ----------
let grid = applyOps(emptyDoc('mx', 'Matrix'), [
  op.addScene({ id: 'g1', name: 'Grid', duration: 8, background: '#101418', nodes: [] }),
  op.addNode('g1', {
    ...({ position: { x: 960, y: 540 }, scale: 1, rotation: 0, opacity: 1, tracks: [] } as const),
    id: 'm', type: 'matrix', cells: [['1', '2'], ['3', '4']],
    cellWidth: 120, cellHeight: 90, fontSize: 48, color: '#ffffff', brackets: 'square',
    transitions: [
      { type: 'cellMorph', start: 2, duration: 2, toCells: [['1', '9'], ['3', '4']], easing: 'linear' },
    ],
  }),
])
const mat = grid.scenes[0]!.nodes[0]!
assert.equal(resolveNode(mat, 1).cellMorph, null, 'no morph before it starts')
const midCells = resolveNode(mat, 3).cellMorph
assert.ok(midCells && midCells.progress > 0.4 && midCells.progress < 0.6, 'halfway through at the midpoint')
assert.deepEqual(midCells!.fromCells, [['1', '2'], ['3', '4']], 'morphing from the base grid')
const settled = resolveNode(mat, 6).cellMorph
assert.ok(settled && settled.progress === 1 && settled.fromCells[0]![1] === '9', 'settles on the result')

// Shape may change, and the moment survives to the contact sheet.
const gridMoments = keyMoments(grid).filter((m) => m.kind === 'cellMorph')
assert.equal(gridMoments.length, 3, 'a cell morph is sampled across its span like a tex morph')
assert.match(gridMoments[1]!.label, /cells → 2x2/, 'the tile label names the target shape')

// Ragged input is refused by the schema rather than rendering a torn grid.
assert.throws(
  () => applyOps(grid, [op.updateNode('g1', 'm', { cells: [['1', '2'], ['3']] })]),
  /same number of cells/,
  'rows of different lengths are rejected',
)
assert.throws(
  () => applyOps(grid, [op.updateNode('g1', 'm', { cells: [Array(500).fill('x')] })]),
  /cell limit/,
  'and a grid past the cell limit is refused — one node must not become 500 sprites',
)
assert.match(outlineDoc(grid), /matrix m .* 2x2 \[1 2 ; 3 4\]/, 'the outline names the shape and contents')


// ---------- pseudo-3D: projection ----------
// The whole third dimension is this function plus three cues. Pure arithmetic
// on (point, camera), so it is checkable without a browser — and it has to be,
// because the cues are what the eye judges and the maths is what the eye
// cannot.
const flatCam = { focus: { x: 960, y: 540 }, yaw: 0, pitch: 0, distance: 2000 }
const at0 = project3({ x: 1000, y: 500, z: 0 }, flatCam)!
assert.deepEqual(
  { x: at0.x, y: at0.y, scale: at0.scale, depth: at0.depth, dim: at0.dim },
  { x: 1000, y: 500, scale: 1, depth: 0, dim: 1 },
  'the z=0 plane through the focus is untouched — a flat scene must stay flat',
)
assert.ok(isFlatCamera(flatCam), 'no yaw and no pitch is a flat camera')

// Nearer is bigger and brighter; further is smaller and dimmer. Distance 2000
// with z=+500 gives 2000/1500 = 1.33.
const near = project3({ x: 960, y: 540, z: 500 }, flatCam)!
const far = project3({ x: 960, y: 540, z: -500 }, flatCam)!
assert.ok(Math.abs(near.scale - 4 / 3) < 1e-9, 'perspective scale is distance/(distance − z)')
assert.ok(Math.abs(far.scale - 0.8) < 1e-9)
assert.ok(near.depth > far.depth, 'depth orders the painter\'s sort, near last')
assert.ok(far.dim < 1 && far.dim < near.dim, 'distance dims — without the cue it reads flat')
assert.equal(near.dim, 1, 'nearer than the focus plane is never dimmed, only enlarged')

// A point at the camera cannot be projected. Left undrawn rather than flung
// across the frame at enormous scale, which is what the divide would do.
assert.equal(project3({ x: 960, y: 540, z: 2000 }, flatCam), null, 'at the camera: culled')
assert.equal(project3({ x: 960, y: 540, z: 5000 }, flatCam), null, 'behind it: culled')

// A quarter turn swaps x for depth: a point 300 to the right ends up 300
// toward the viewer, and stops being to the right at all.
const turned = project3({ x: 1260, y: 540, z: 0 }, { ...flatCam, yaw: Math.PI / 2 })!
assert.ok(Math.abs(turned.x - 960) < 1e-9, 'x collapses to the focus at a quarter turn')
assert.ok(Math.abs(turned.depth + 300) < 1e-9, 'and becomes depth — away from the viewer')
assert.ok(turned.scale < 1, 'so it is further away and draws smaller')

// Pitch: positive lifts the camera and looks DOWN, so something toward the
// viewer appears lower on screen. The sign is the easy thing to get backwards
// and impossible to argue about from the code alone.
const tipped = project3({ x: 960, y: 540, z: 400 }, { ...flatCam, pitch: 0.4 })!
assert.ok(tipped.y > 540, 'a positive pitch pushes near things down the frame')
const behind = project3({ x: 960, y: 540, z: -400 }, { ...flatCam, pitch: 0.4 })!
assert.ok(behind.y < 540, 'and far things up it — that is a ground plane receding')

// ---------- the scene only goes 3D when it has reason to ----------
const spatialDoc = applyOps(emptyDoc('sp', 'Space'), [
  op.addScene({ id: 'v1', name: 'Void', duration: 5, background: '#101418', nodes: [] }),
  op.addNode('v1', {
    id: 'dot', type: 'circle', radius: 40, fill: '#ffffff', strokeWidth: 0,
    position: { x: 960, y: 540 }, scale: 1, rotation: 0, opacity: 1, tracks: [], transitions: [],
  }),
])
const canvas3 = { width: 1920, height: 1080, fps: 60 } as const
assert.equal(
  resolveScene(spatialDoc.scenes[0]!, 0, canvas3).spatial,
  false,
  'a flat scene must not be projected or depth-sorted at all',
)
assert.equal(resolveScene(spatialDoc.scenes[0]!, 0, canvas3).nodes[0]!.projection, null)

// Give the same node a depth and it starts being projected.
const withZ = applyOps(spatialDoc, [op.updateNode('v1', 'dot', { z: 400 })])
const resolvedZ = resolveScene(withZ.scenes[0]!, 0, canvas3)
assert.ok(resolvedZ.spatial, 'a node with a depth makes the scene spatial')
assert.ok(resolvedZ.nodes[0]!.projection!.scale > 1, 'and it projects nearer than the plane')
// No camera on the scene, so the fallback focus is the canvas centre: a node
// already at the centre must not slide sideways as it comes forward.
assert.equal(resolvedZ.nodes[0]!.projection!.x, 960, 'the fallback focus is the canvas centre')

// A camera with a yaw makes even flat nodes spatial, because the whole scene
// is being looked at from an angle.
const orbited = applyOps(spatialDoc, [
  op.setCamera('v1', { ...defaultCamera(canvas3), yaw: 0.5 }),
])
assert.ok(resolveScene(orbited.scenes[0]!, 0, canvas3).spatial, 'a turned camera is spatial')
assert.match(outlineDoc(orbited), /yaw=0\.5 pitch=0 dist=2000/, 'the outline reports the orbit')

// Distance is clamped at sample time for the same reason zoom is: a keyframe
// that walks the camera inside the diagram inverts the projection.
const tooClose = applyOps(spatialDoc, [
  op.setCamera('v1', {
    ...defaultCamera(canvas3),
    yaw: 0.3,
    tracks: [{ property: 'distance', keyframes: [{ t: 0, value: 1, easing: 'linear' }] }],
  }),
])
assert.ok(
  resolveCamera(tooClose.scenes[0]!, 0)!.distance >= 200,
  'a camera distance keyframed into the scene is clamped, not rendered inside out',
)

console.log(
  'smoke OK — reducer, sampler, morph resolution, key moments, camera framing, ' +
    'grid layout, stagger, cell matching, projection, path reveal, expressions and ' +
    'plot mapping all behave',
)
