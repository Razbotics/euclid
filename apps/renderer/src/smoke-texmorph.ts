/**
 * Matched-glyph LaTeX morphing: correspondence and interpolation.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-texmorph.ts
 *
 * Free — pure logic. Coordinates below are the real MathJax output for these
 * two equations, so the assertions describe what actually happens on screen
 * rather than a convenient fiction.
 */
import assert from 'node:assert'
import { applyOps, emptyDoc, op } from '@euclid/dsl'
import {
  findGlyphRun,
  glyphBounds,
  matchGlyphs,
  morphGlyphs,
  resolveNode,
  writeGlyphAlphas,
  type TexGlyph,
} from '@euclid/engine'

/** Build glyphs from MathJax `data-c` codes and x positions (em units). */
const glyphs = (spec: [string, number, number?][]): TexGlyph[] =>
  spec.map(([code, x, height]) => ({ code, x, y: 0, width: 50, height: height ?? 100 }))

// x^2 + b x = c   — measured from MathJax
const FROM = glyphs([
  ['1D465', 0], // x
  ['32', 605, 70], // 2, superscript: smaller
  ['2B', 1230.8], // +
  ['1D44F', 2231], // b
  ['1D465', 2660], // x
  ['3D', 3509.8], // =
  ['1D450', 4565.6], // c
])
// x^2 + b x + c = 0
const TO = glyphs([
  ['1D465', 0],
  ['32', 605, 70],
  ['2B', 1230.8],
  ['1D44F', 2231],
  ['1D465', 2660],
  ['2B', 3454.2], // new +
  ['1D450', 4454.4], // c moved
  ['3D', 5165.2], // = moved right
  ['30', 6221], // new 0
])

const match = matchGlyphs(FROM, TO)

// The shared prefix must match, and — the whole point — it must not move.
const prefix = match.pairs.slice(0, 5)
assert.deepEqual(
  prefix.map((p) => [p.fromIndex, p.toIndex]),
  [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ],
  'x, 2, +, b, x must pair with themselves',
)
for (const p of prefix) {
  assert.equal(FROM[p.fromIndex]!.x, TO[p.toIndex]!.x, 'unchanged prefix glyphs must not move at all')
}

// Matching must preserve order: no matched pair may cross another.
for (let i = 1; i < match.pairs.length; i++) {
  assert.ok(match.pairs[i]!.fromIndex > match.pairs[i - 1]!.fromIndex, 'from indices strictly increase')
  assert.ok(match.pairs[i]!.toIndex > match.pairs[i - 1]!.toIndex, 'to indices strictly increase')
}

// Every glyph is accounted for exactly once.
assert.equal(match.pairs.length + match.removed.length, FROM.length, 'every from-glyph is paired or removed')
assert.equal(match.pairs.length + match.added.length, TO.length, 'every to-glyph is paired or added')
assert.ok(match.pairs.length >= 6, `expected a long common subsequence, got ${match.pairs.length}`)

// ---------- interpolation ----------
const at = (u: number) => morphGlyphs(FROM, TO, match, u)

// At the start, matched glyphs sit exactly on their source positions.
for (const g of at(0).filter((g) => g.alpha === 1)) {
  assert.equal(g.x, FROM[g.index]!.x, 'at progress 0 a matched glyph is at its from-position')
}
// At the end, exactly on their targets.
const endPairs = at(1).filter((g) => g.source === 'from' && g.alpha === 1)
for (const g of endPairs) {
  const pair = match.pairs.find((p) => p.fromIndex === g.index)!
  assert.equal(g.x, TO[pair.toIndex]!.x, 'at progress 1 a matched glyph has reached its to-position')
}

// A glyph present in both, at the same place, must be perfectly still throughout.
for (const u of [0, 0.25, 0.5, 0.75, 1]) {
  const b = at(u).find((g) => g.source === 'from' && g.index === 3)! // the 'b'
  assert.equal(b.x, 2231, `the unchanged 'b' must never move (progress ${u})`)
  assert.equal(b.alpha, 1, 'a matched glyph never fades')
}

// The superscript keeps its smaller size rather than snapping to full size.
const two = at(1).find((g) => g.source === 'from' && g.index === 1)!
assert.ok(Math.abs(two.scale - 1) < 1e-9, 'a superscript matching a superscript keeps scale 1')

// Fades are staggered: nothing new appears while the old is still leaving.
const mid = at(0.5)
assert.equal(mid.filter((g) => g.alpha > 0 && g.alpha < 1).length, 0, 'at the midpoint nothing is half-faded')
const quarter = at(0.25)
assert.ok(quarter.some((g) => g.source === 'from' && g.alpha < 1), 'removed glyphs are fading out early')
assert.ok(!quarter.some((g) => g.source === 'to'), 'nothing new has appeared yet at 25%')
const late = at(0.85)
assert.ok(late.some((g) => g.source === 'to' && g.alpha > 0), 'added glyphs are fading in late')
assert.ok(!late.some((g) => g.source === 'from' && g.alpha < 1), 'removed glyphs are fully gone by then')

// Degenerate inputs must not throw or produce NaN.
assert.deepEqual(matchGlyphs([], []), { pairs: [], removed: [], added: [] })
assert.equal(morphGlyphs([], [], matchGlyphs([], []), 0.5).length, 0)
const allNew = matchGlyphs([], TO)
assert.equal(allNew.added.length, TO.length, 'morphing from nothing adds everything')
for (const g of morphGlyphs([], TO, allNew, 0.9)) {
  assert.ok(Number.isFinite(g.x) && Number.isFinite(g.scale), 'no NaN geometry')
}
// Identical equations: everything matches, nothing fades, nothing moves.
const same = matchGlyphs(FROM, FROM)
assert.equal(same.pairs.length, FROM.length)
assert.equal(same.removed.length + same.added.length, 0)
for (const g of morphGlyphs(FROM, FROM, same, 0.5)) {
  assert.equal(g.x, FROM[g.index]!.x, 'morphing an equation into itself is perfectly still')
}

// ---------- highlight: locating a term by its glyphs ----------
// This is how `highlight` targets \frac{b}{a} without knowing coordinates:
// render the fragment, take its codes, find that run in the equation.

// "b x" inside x^2 + b x = c — codes [1D44F, 1D465] at indices 3..5.
const run = findGlyphRun(FROM, ['1D44F', '1D465'])
assert.deepEqual(run, [3, 5], 'a two-glyph fragment is found at the right offset')

// The match must be contiguous, not a scattered subsequence: 'x' then 'c'
// appear in that order but are not adjacent, so this is not a hit.
assert.equal(findGlyphRun(FROM, ['1D465', '1D450']), null, 'non-adjacent codes are not a run')
assert.equal(findGlyphRun(FROM, ['9999']), null, 'a fragment that is not present returns null')
assert.equal(findGlyphRun(FROM, []), null, 'an empty fragment matches nothing')
assert.equal(findGlyphRun([], ['1D465']), null, 'no glyphs, no match')

// The first occurrence wins — 'x' appears twice.
assert.deepEqual(findGlyphRun(FROM, ['1D465']), [0, 1], 'the first occurrence is returned')

const bounds = glyphBounds(FROM, 3, 5)!
assert.ok(bounds, 'bounds exist for a valid range')
// Spans from the left edge of 'b' to the right edge of 'x'.
assert.equal(bounds.x, (2231 - 25 + 2660 + 25) / 2, 'bounds are centred on the run')
assert.equal(bounds.width, 2660 + 25 - (2231 - 25), 'bounds span the whole run')
assert.equal(glyphBounds(FROM, 2, 2), null, 'an empty range has no bounds')
assert.equal(glyphBounds(FROM, 0, 99), null, 'an out-of-range request is refused, not clamped')

// ---------- highlight: the pulse envelope ----------
// An emphasis appears, holds while the narration talks, then leaves. A
// monotonic 0→1 would read as a wipe.
const node = {
  id: 'eq',
  type: 'latex' as const,
  tex: 'a^2',
  color: '#ffffff',
  fontSize: 64,
  position: { x: 0, y: 0 },
  scale: 1,
  rotation: 0,
  opacity: 1,
  tracks: [],
  transitions: [
    { type: 'highlight' as const, start: 2, duration: 1, tex: 'a', style: 'box' as const, color: '#e8c74a' },
  ],
}
const strengthAt = (t: number) => resolveNode(node, t).highlight?.strength ?? null
assert.equal(strengthAt(1.9), null, 'no highlight before it starts')
assert.equal(strengthAt(3.1), null, 'no highlight after it ends')
assert.equal(strengthAt(2.0), 0, 'starts from nothing')
assert.equal(strengthAt(3.0), 0, 'ends at nothing')
assert.equal(strengthAt(2.5), 1, 'holds at full strength through the middle')
const rising = strengthAt(2.09)!
assert.ok(rising > 0 && rising < 1, `ramps in rather than snapping (got ${rising})`)
assert.ok(strengthAt(2.12)! > rising, 'strength increases while ramping in')
assert.ok(strengthAt(2.95)! < strengthAt(2.9)!, 'strength decreases while ramping out')
assert.equal(resolveNode(node, 2.5).highlight?.tex, 'a', 'the target survives resolution')

// All four emphasis styles round-trip through the schema and the sampler.
// `color` and `spotlight` act on the type itself and need per-glyph
// rendering; `box` and `underline` draw a marker around it.
for (const style of ['box', 'underline', 'color', 'spotlight'] as const) {
  const doc = applyOps(
    applyOps(emptyDoc('h', 'Styles'), [
      op.addScene({ id: 'h1', name: 'S', duration: 5, background: '#000000', nodes: [] }),
    ]),
    [
      op.addNode('h1', {
        ...node,
        id: `eq_${style}`,
        transitions: [{ type: 'highlight', start: 1, duration: 2, tex: 'a', style, color: '#e8c74a' }],
      }),
    ],
  )
  const resolved = resolveNode(doc.scenes[0]!.nodes[0]!, 2)
  assert.equal(resolved.highlight?.style, style, `${style} survives validation and resolution`)
}

// ---------- write: glyph-by-glyph reveal ----------
// The old write swept one mask edge across, slicing glyphs in half as it
// passed. Revealing symbol by symbol reads like someone writing it out.
const w = (u: number) => writeGlyphAlphas(FROM.length, u)

assert.deepEqual(w(0), FROM.map(() => 0), 'nothing is drawn at the start')
assert.deepEqual(w(1), FROM.map(() => 1), 'everything is drawn at the end')

// Reading order: an earlier glyph is never fainter than a later one.
for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) {
  const a = w(u)
  for (let i = 1; i < a.length; i++) {
    assert.ok(a[i - 1]! >= a[i]!, `glyph ${i - 1} must lead glyph ${i} (progress ${u})`)
  }
  assert.ok(a.every((x) => x >= 0 && x <= 1), 'alphas stay in range')
}

// Glyphs overlap rather than appearing strictly one at a time, so it flows.
const partial = w(0.5).filter((a) => a > 0 && a < 1)
assert.ok(partial.length >= 2, `expected several glyphs mid-fade, got ${partial.length}`)

// Monotonic in time: a glyph never dims as the write proceeds.
for (let i = 0; i < FROM.length; i++) {
  assert.ok(w(0.6)[i]! >= w(0.4)[i]!, `glyph ${i} must not dim as the write proceeds`)
}

assert.deepEqual(writeGlyphAlphas(0, 0.5), [], 'no glyphs, no alphas')
assert.deepEqual(writeGlyphAlphas(1, 0.4), [0.4], 'a single glyph just tracks progress')
assert.ok(writeGlyphAlphas(3, -1).every((a) => a === 0), 'progress below 0 is clamped')
assert.ok(writeGlyphAlphas(3, 2).every((a) => a === 1), 'progress above 1 is clamped')

console.log(
  `texmorph OK — ${match.pairs.length}/${FROM.length} glyphs matched and stationary, ` +
    `${match.removed.length} fade out before ${match.added.length} fade in; order preserved. ` +
    `highlight: run at [${run![0]},${run![1]}), pulse ramps 0→1→0; write reveals in reading order`,
)
