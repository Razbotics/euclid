/**
 * Matched-glyph LaTeX morphing: correspondence and interpolation.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-texmorph.ts
 *
 * Free — pure logic. Coordinates below are the real MathJax output for these
 * two equations, so the assertions describe what actually happens on screen
 * rather than a convenient fiction.
 */
import assert from 'node:assert'
import { matchGlyphs, morphGlyphs, type TexGlyph } from '@euclid/engine'

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

console.log(
  `texmorph OK — ${match.pairs.length}/${FROM.length} glyphs matched and stationary, ` +
    `${match.removed.length} fade out before ${match.added.length} fade in; order preserved`,
)
