/**
 * add_arc (plans/011 gap 7): circles, ellipses, arcs and polygons without
 * typing the points — measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-arc.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * Two claims, and the second is the one that matters. The first is that the
 * generated points are the right points, which is arithmetic and is checked
 * against the pure function directly. The second is that what comes out is an
 * **ordinary path** and nothing downstream knows it was sugar — so the same
 * node is filled, ridden by flow_along and framed by a camera here, and the
 * document is inspected to confirm it holds plain points rather than a formula.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { sampleArc } from '@euclid/dsl'
import { pathLength } from '@euclid/engine'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'
const BG = '#101418'
const TAU = Math.PI * 2

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(
    `preview backend not running at ${PREVIEW}\n` +
      '  pnpm --filter @euclid/renderer exec tsx src/render-worker.ts',
  )
  process.exit(1)
}

const run = async (name: string, args: Record<string, unknown>) => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args)
  assert.equal(r.status, 200, `${name} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any; image?: { base64: string } }
}
async function inkAt(projectId: string, at: number[], save?: string): Promise<number[]> {
  const shot = await ok('preview_frames', { projectId, at, columns: at.length })
  if (save && shot.image) writeFileSync(`${OUT}/${save}`, Buffer.from(shot.image.base64, 'base64'))
  return shot.data.ink as number[]
}
const pct = (v: number) => `${(v * 100).toFixed(2)}%`
const round = (n: number) => Math.round(n * 1000) / 1000

/** preview_frames takes global time; scenes play in sequence. Ask the document
 *  rather than adding durations up by hand. */
async function sceneStart(projectId: string, sceneId: string): Promise<number> {
  const { doc } = (await (
    await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
  ).json()) as { doc: { scenes: { id: string; duration: number }[] } }
  let acc = 0
  for (const sc of doc.scenes) {
    if (sc.id === sceneId) return acc
    acc += sc.duration
  }
  throw new Error(`scene ${sceneId} not found`)
}

// ---------- 1. the points are the right points ----------
// Pure, so this is arithmetic rather than a rendering. Checked here and not
// only in the capability because these are the numbers everything below is
// measured against — a wrong circle drawn consistently would pass every pixel
// test in this file.
const circle = sampleArc({ rx: 100, ry: 100, startAngle: 0, endAngle: TAU, samples: 64 })
assert.equal(circle.points.length, 64, 'a full turn yields exactly `samples` points')
assert.ok(circle.fullTurn, 'and knows it came back round')
// An inscribed 64-gon is a shade under the true circumference, never over.
const per = pathLength(circle.points, true)
assert.ok(
  per < TAU * 100 && per > TAU * 100 - 1,
  `a 64-gon must sit just inside 2πr: ${round(per)} vs ${round(TAU * 100)}`,
)
// The endpoint is dropped on a full turn, so the last point is one step short
// of the first rather than a duplicate of it.
assert.notDeepStrictEqual(
  circle.points[63],
  circle.points[0],
  'a full turn must not repeat its first point — that is a zero-length side',
)

// Four samples around a circle is a diamond, which pins the angle convention:
// positive angles go clockwise on screen, because canvas y points down.
const diamond = sampleArc({ rx: 100, ry: 100, startAngle: 0, endAngle: TAU, samples: 4 })
assert.deepStrictEqual(
  diamond.points.map((p) => ({ x: round(p.x), y: round(p.y) })),
  [
    { x: 100, y: 0 },
    { x: 0, y: 100 },
    { x: -100, y: 0 },
    { x: -0, y: -100 },
  ],
  'angle 0 is 3 o\'clock and positive turns CLOCKWISE (canvas y is down)',
)

// rx and ry are the horizontal and vertical radii, and `rotation` tilts the
// ellipse rather than sweeping the angle — the same thing only on a circle.
const ell = sampleArc({ rx: 200, ry: 100, startAngle: 0, endAngle: TAU, samples: 4 })
assert.deepStrictEqual(
  [round(ell.points[0]!.x), round(ell.points[1]!.y)],
  [200, 100],
  'rx is the horizontal radius and ry the vertical one',
)
const tilted = sampleArc({ rx: 200, ry: 100, startAngle: 0, endAngle: TAU, rotation: Math.PI / 2, samples: 4 })
assert.deepStrictEqual(
  [round(tilted.points[0]!.x), round(tilted.points[0]!.y)],
  [0, 200],
  'a quarter-turn tilt stands the long axis up',
)

// An arc keeps both ends, because neither coincides with the other.
const half = sampleArc({ rx: 100, ry: 100, startAngle: 0, endAngle: Math.PI, samples: 3 })
assert.ok(!half.fullTurn, 'a half turn is not a full one')
assert.deepStrictEqual(
  [round(half.points[2]!.x), round(half.points[2]!.y)],
  [-100, 0],
  'an arc is sampled inclusively, so it reaches the angle it was asked for',
)
console.log('points OK — 64-gon inside 2πr, no duplicate endpoint, clockwise from 3 o\'clock')

// ---------- 2. it is an ordinary path, holding plain points ----------
const projectId = (await ok('create_project', { name: 'Arc Check' })).data.id
const ringScene = (await ok('add_scene', { projectId, name: 'Ring', duration: 6, background: BG }))
  .data.sceneId
const ring = await ok('add_arc', {
  projectId, sceneId: ringScene, x: 960, y: 540, rx: 300, samples: 64,
  stroke: '#58c4dd', strokeWidth: 6,
})
assert.match(ring.text, /circle/, `the reply must name what it made: ${ring.text}`)
assert.match(ring.text, /1884px around/, 'and report the perimeter it will be ridden by')
const ringId = ring.data.nodeId as string

// The sugar must leave nothing behind in the document — that is the whole
// argument plot_function established: the formula lives in the call, never in
// the node, so every downstream consumer sees one shape of thing.
const scene = (await ok('get_scene', { projectId, sceneId: ringScene })).data.scene
const node = (scene.nodes as any[]).find((n) => n.id === ringId)
assert.equal(node.type, 'path', 'add_arc must produce a path node, not a new node type')
assert.equal(node.points.length, 64, 'holding the sampled points')
assert.equal(node.closed, true, 'closed, because the sweep came back round')
for (const key of ['rx', 'ry', 'startAngle', 'endAngle', 'samples', 'shape']) {
  assert.ok(!(key in node), `the document must not remember \`${key}\` — sugar compiles away`)
}
console.log('document OK — a plain path of 64 points, with no memory of being a circle')

// ---------- 3. and it draws where it says, as a ring rather than a disc ----------
// Two frames: one on the rim at 3 o'clock, one on the centre. An unfilled
// circle lights the first and leaves the second dark, which no measure of
// total ink could distinguish — a disc of the same radius lights both.
await ok('set_camera', { projectId, sceneId: ringScene, x: 1260, y: 540, zoom: 6 })
const [rimInk] = await inkAt(projectId, [0.5], 'check-arc-rim.png')
await ok('set_camera', { projectId, sceneId: ringScene, x: 960, y: 540, zoom: 6 })
const [holeInk] = await inkAt(projectId, [0.5], 'check-arc-hole.png')
assert.ok(rimInk! > 0.02, `the rim must be at (1260,540), r=300 from the centre: ${pct(rimInk!)}`)
assert.ok(holeInk! < 0.005, `and the middle must be empty — this is a ring: ${pct(holeInk!)}`)

// Fill it and the same geometry becomes a disc: the middle lights up. This is
// the claim that it is a real path — `fill` is a path property, not something
// add_arc had to reimplement.
const discScene = (await ok('add_scene', { projectId, name: 'Disc', duration: 4, background: BG }))
  .data.sceneId
await ok('add_arc', {
  projectId, sceneId: discScene, x: 960, y: 540, rx: 300, samples: 64,
  stroke: '#58c4dd', strokeWidth: 6, fill: '#e8c74a',
})
await ok('set_camera', { projectId, sceneId: discScene, x: 960, y: 540, zoom: 6 })
const discStart = await sceneStart(projectId, discScene)
const [discInk] = await inkAt(projectId, [discStart + 0.5], 'check-arc-disc.png')
assert.ok(
  discInk! > 0.9,
  `the same circle with a fill must flood the middle frame: ${pct(holeInk!)} → ${pct(discInk!)}`,
)
console.log(`ring OK — rim ${pct(rimInk!)}, hole ${pct(holeInk!)}, filled ${pct(discInk!)}`)

// ---------- 4. a generated path can be ridden, which is the point ----------
// If add_arc had produced anything special, this is where it would show: the
// speed profile from the same plan rides the sugar with no special case.
const rider = (
  await ok('add_shape', {
    projectId, sceneId: ringScene, shape: 'circle', x: 1260, y: 540, radius: 24, fill: '#a6e22e',
  })
).data.nodeId
await ok('flow_along', {
  projectId, sceneId: ringScene, nodeId: rider, pathId: ringId,
  at: [{ t: 0, u: 0 }, { t: 4, u: 1 }], easing: 'linear',
})
// u = 0.25 lands on vertex 16 of 64, which is exactly a quarter turn — and a
// quarter turn CLOCKWISE from 3 o'clock is 6 o'clock, (960, 840).
const quarter = await ok('sample_at', { projectId, sceneId: ringScene, t: 1, nodeIds: [rider] })
const at1 = (quarter.data.nodes as any[]).find((n) => n.id === rider).world
assert.ok(
  Math.hypot(at1.x - 960, at1.y - 840) < 1.5,
  `a quarter of the way round a generated circle is 6 o'clock, (960,840), got ` +
    `(${round(at1.x)}, ${round(at1.y)}) — the sugar must ride like any other path`,
)
console.log('composition OK — flow_along rides a generated circle to (960,840) at a quarter turn')

// ---------- 5. the errors teach ----------
const noSweep = await run('add_arc', {
  projectId, sceneId: ringScene, x: 100, y: 100, rx: 50, startAngle: 1, endAngle: 1,
})
assert.equal(noSweep.status, 400)
assert.match(noSweep.body, /sweeps nothing/, 'a zero sweep is refused')
assert.match(noSweep.body, /Leave both out for a whole circle/, 'and says what to do instead')

const twoSided = await run('add_arc', {
  projectId, sceneId: ringScene, x: 100, y: 100, rx: 50, samples: 2,
})
assert.equal(twoSided.status, 400)
assert.match(twoSided.body, /at least 3 samples/, 'a two-sided polygon is refused')
assert.match(twoSided.body, /3 is a\s+triangle/, 'and explains that samples is the side count')

const noRadius = await run('add_arc', { projectId, sceneId: ringScene, x: 100, y: 100, rx: 0 })
assert.equal(noRadius.status, 400, 'a zero radius is refused')

// The obvious mistake: degrees. It draws a plausible whole ellipse, so it has
// to be named in the response rather than left for a contact sheet to reveal.
const degrees = await ok('add_arc', {
  projectId, sceneId: ringScene, x: 200, y: 200, rx: 40, startAngle: 0, endAngle: 90,
})
assert.match(degrees.text, /14\.3 full turns/, `a degrees-shaped sweep is reported: ${degrees.text}`)
assert.match(degrees.text, /RADIANS/, 'and named as the unit mistake it is')
assert.match(degrees.text, /pass 1\.5708/, 'with the value that was actually meant')

await ok('delete_project', { projectId, confirm: true })

console.log(
  `arc OK — 64-gon just inside 2πr with no duplicate endpoint, clockwise from 3 o'clock, ` +
    `rx/ry and tilt independent; the node is a plain 64-point path with no memory of being a ` +
    `circle; rim ${pct(rimInk!)} vs hole ${pct(holeInk!)} proves a ring and ${pct(discInk!)} ` +
    `proves fill; flow_along rides it to 6 o'clock at a quarter turn. Zero sweep, two-sided ` +
    `polygon, zero radius and a degrees-shaped sweep all teach. Frames in ${OUT}/check-arc-*.png`,
)
