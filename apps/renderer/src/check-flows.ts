/**
 * Flows (plans/006 Phase D): arrows that track what they point at, and nodes
 * that travel along paths — measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-flows.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * The claim here is *tracking*: an arrow between two nodes must be recomputed
 * every frame, not baked at creation. Lit fraction alone cannot see that — the
 * arrow is lit either way — so the test frames the camera tightly on the place
 * the head must reach after its target has moved. An anchored arrow lights that
 * frame; one baked at creation leaves it empty.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { sampleFlowU, sampleKeyframes } from '@euclid/engine'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'
const BG = '#101418'

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

/**
 * Global start of a scene, asked of the document rather than added up by hand.
 * Counting scene durations in your head is how this file twice sampled the
 * wrong scene and then trusted the reading.
 */
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

const projectId = (await ok('create_project', { name: 'Flow Check' })).data.id

// ---------- 1. an arrow tracks the node it is anchored to ----------
// A box starts beside its target and travels far away. The camera is framed on
// the corridor the arrow must stretch across once it has gone: an anchored
// arrow lights it, a baked one is nowhere near.
const trackScene = (await ok('add_scene', { projectId, name: 'Track', duration: 6, background: BG }))
  .data.sceneId
const box = (
  await ok('add_shape', {
    projectId, sceneId: trackScene, shape: 'rect', x: 500, y: 700, width: 220, height: 120,
    fill: '#58c4dd',
  })
).data.nodeId
const target = (
  await ok('add_shape', {
    projectId, sceneId: trackScene, shape: 'circle', x: 500, y: 300, radius: 90, fill: '#fc6255',
  })
).data.nodeId
const link = (await ok('connect', { projectId, sceneId: trackScene, from: box, to: target })).data
  .nodeId
await ok('animate', {
  projectId, sceneId: trackScene, nodeId: box, property: 'position',
  to: { x: 1500, y: 700 }, start: 1, duration: 3,
})
// Straight down the middle of where the arrow ends up, and nowhere near where
// it was drawn at t=0.
await ok('set_camera', { projectId, sceneId: trackScene, x: 1050, y: 520, zoom: 6 })
const [before, after] = await inkAt(projectId, [0.5, 5], 'check-flows-track.png')
assert.ok(
  before! < 0.01,
  `nothing should cross this frame before the box moves (${pct(before!)})`,
)
assert.ok(
  after! > before! * 5 && after! > 0.02,
  `the arrow must be recomputed as its anchor moves: ${pct(before!)} → ${pct(after!)}. ` +
    `An arrow baked at creation would leave this frame empty.`,
)

// ---------- 2. it stops at the edge, and a curve bows off the chord ----------
const shapeScene = (await ok('add_scene', { projectId, name: 'Shape', duration: 4, background: BG }))
  .data.sceneId
const a = (
  await ok('add_shape', {
    projectId, sceneId: shapeScene, shape: 'circle', x: 500, y: 540, radius: 120, fill: '#1b2733',
    stroke: '#58c4dd',
  })
).data.nodeId
const b = (
  await ok('add_shape', {
    projectId, sceneId: shapeScene, shape: 'circle', x: 1420, y: 540, radius: 120, fill: '#1b2733',
    stroke: '#58c4dd',
  })
).data.nodeId
await ok('connect', { projectId, sceneId: shapeScene, from: a, to: b, curve: 0.25 })
await ok('connect', { projectId, sceneId: shapeScene, from: b, to: a, curve: 0.25 })
const [pair] = await inkAt(projectId, [6 + 2], 'check-flows-curve.png')
assert.ok(pair! > 0.004, `two curved connectors must draw (${pct(pair!)})`)

// A straight pair in the same geometry covers less ground than a bowed pair,
// because the two bows separate instead of lying on top of one another.
const straightScene = (
  await ok('add_scene', { projectId, name: 'Straight', duration: 4, background: BG })
).data.sceneId
const c = (
  await ok('add_shape', {
    projectId, sceneId: straightScene, shape: 'circle', x: 500, y: 540, radius: 120,
    fill: '#1b2733', stroke: '#58c4dd',
  })
).data.nodeId
const d = (
  await ok('add_shape', {
    projectId, sceneId: straightScene, shape: 'circle', x: 1420, y: 540, radius: 120,
    fill: '#1b2733', stroke: '#58c4dd',
  })
).data.nodeId
await ok('connect', { projectId, sceneId: straightScene, from: c, to: d })
await ok('connect', { projectId, sceneId: straightScene, from: d, to: c })
const [straight] = await inkAt(projectId, [10 + 2])
assert.ok(
  pair! > straight!,
  `curved connectors must separate rather than overlap: straight ${pct(straight!)} ` +
    `vs curved ${pct(pair!)}`,
)

// ---------- 3. a node travelling a path ----------
// The camera watches the far end of the path. The token only reaches it if the
// follow is actually driving its position by arc length.
const flowScene = (await ok('add_scene', { projectId, name: 'Flow', duration: 8, background: BG }))
  .data.sceneId
const wire = (
  await ok('add_path', {
    projectId, sceneId: flowScene, x: 300, y: 300,
    points: [
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 400 }, { x: 900, y: 400 },
      { x: 900, y: 700 },
    ],
    stroke: '#3a4450', strokeWidth: 4,
  })
).data.nodeId
const token = (
  await ok('add_shape', {
    projectId, sceneId: flowScene, shape: 'circle', x: 300, y: 300, radius: 34, fill: '#e8c74a',
  })
).data.nodeId
const flow = await ok('flow_along', {
  projectId, sceneId: flowScene, nodeId: token, pathId: wire, start: 1, duration: 4,
})
// 300 + 400 + 600 + 300 down the dog-leg.
assert.match(flow.text, /1600px/, 'the response reports the real arc length of the path')

await ok('set_camera', { projectId, sceneId: flowScene, x: 1200, y: 1000, zoom: 5 })
const flowAt = await sceneStart(projectId, flowScene)
const travel = await inkAt(projectId, [flowAt + 1.2, flowAt + 5.5], 'check-flows-travel.png')
assert.ok(
  travel[0]! < travel[1]!,
  `the token must arrive at the far end of the path: ${travel.map(pct).join(' → ')}`,
)
// A 34px token at zoom 5 covers about 4.4% of the frame; anything near that
// is the token itself rather than the path line clipping the corner.
assert.ok(travel[1]! > 0.03, 'and be plainly there, not a sliver')

// ---------- 3b. a speed profile paces the same path (plans/011) ----------
// The claim is that `at` decides WHEN the node is where without touching WHERE
// the path goes. So every assertion here is a position on the dog-leg above,
// whose four segments (300+400+600+300 = 1600px from (300,300)) make an arc
// length arithmetic rather than a guess.
//
// Positions come from sample_at, which runs the renderer's own resolver — the
// same argument check-order and check-camera make. A profile that agreed with
// this file's arithmetic but not with the stage would be worse than none.
const posOf = async (sceneId: string, nodeId: string, t: number): Promise<[number, number]> => {
  const s = await ok('sample_at', { projectId, sceneId, t, nodeIds: [nodeId] })
  const hit = (s.data.nodes as { id: string; world: { x: number; y: number } }[]).find(
    (n) => n.id === nodeId,
  )
  assert.ok(hit, `${nodeId} should be in the sample`)
  return [hit!.world.x, hit!.world.y]
}
const near = (got: [number, number], want: [number, number], why: string, eps = 1.5) =>
  assert.ok(
    Math.hypot(got[0] - want[0], got[1] - want[1]) <= eps,
    `${why}: expected ~(${want}), got (${got.map((v) => v.toFixed(1))})`,
  )

const paced = (
  await ok('add_shape', {
    projectId, sceneId: flowScene, shape: 'circle', x: 300, y: 300, radius: 30, fill: '#a6e22e',
  })
).data.nodeId
// Fast for the first quarter of the time, then slow: 1200px in 1s, 400px in 3s.
// A constant-speed flow over the same span is at u=0.25 when this is at 0.75.
const profiled = await ok('flow_along', {
  projectId, sceneId: flowScene, nodeId: paced, pathId: wire,
  at: [{ t: 0, u: 0 }, { t: 1, u: 0.75 }, { t: 4, u: 1 }], easing: 'linear',
})
// The response reports the speeds it produced rather than the profile back —
// 1200px/s then ~133px/s — because "does it vary the way I meant" is the only
// question this form raises and it is arithmetic the caller would redo by hand.
assert.match(profiled.text, /3-point profile/, 'the reply must say a profile is in force')
assert.match(profiled.text, /133–1200 px\/s/, `the reply must report real speeds: ${profiled.text}`)

// u = 0.75 is 1200px along: 300 + 400 + 500 into the third leg → (1100, 700).
near(await posOf(flowScene, paced, 1), [1100, 700], 'the profile must land where it says at t=1')
// ...and BETWEEN two profile points it interpolates, which is the half that
// landing on them would not prove: at t=0.5, linear from 0 to 0.75 gives
// u=0.375, which is 600px — the whole first leg (300) and 300 down the second,
// so (600, 600). Note this is not u=0.5; the profile is what maps t to u.
near(await posOf(flowScene, paced, 0.5), [600, 600], 'and interpolate by arc length between points')
// Held at the end, like every other transition here.
near(await posOf(flowScene, paced, 7), [1200, 1000], 'and hold the last point after the end')

// The whole point: at t=1 the constant-speed token is nowhere near. Verified
// against the OTHER token in the same scene rather than against a number, so
// this compares the two forms rather than restating the profile.
const [steadyX] = await posOf(flowScene, token, 1 + 1)
assert.ok(
  Math.abs(steadyX - 1100) > 400,
  `a constant-speed flow must be far behind the profiled one at the same moment ` +
    `(${steadyX.toFixed(0)} vs 1100) — otherwise the profile is doing nothing`,
)

// And in pixels, because a resolver that agreed with the arithmetic above but
// not with the stage would be worse than none. The camera is framed tightly on
// (1100, 700) — the point u=0.75 names — so the token is either there at the
// moment the profile claims or it is not: empty, present, empty.
//
// The comparison against constant speed stays with sample_at rather than being
// re-staged here. Both tokens ride one path, so a frame lit by "a token" cannot
// say which, and the existing flow carries the default `smooth` easing, which
// would make its arrival time an easing curve rather than a fact about pacing.
await ok('set_camera', { projectId, sceneId: flowScene, x: 1100, y: 700, zoom: 6 })
const flowStart = await sceneStart(projectId, flowScene)
const [wireOnly, paceArrives, gone] = await inkAt(
  projectId,
  [flowStart + 0.4, flowStart + 1, flowStart + 3.1],
  'check-flows-profile.png',
)
// The wire crosses this frame at every moment, so "empty" is the wire alone.
assert.ok(
  paceArrives! > wireOnly! * 2 && paceArrives! > 0.04,
  `the profiled token must be at (1100,700) one second in: ${pct(wireOnly!)} → ` +
    `${pct(paceArrives!)}. At constant speed it is barely off the first leg.`,
)
assert.ok(
  gone! < paceArrives! / 1.5,
  `and be past it by 3.1s, having slowed: ${pct(paceArrives!)} → ${pct(gone!)}`,
)

// A profile may descend: times move forwards, positions need not. In its own
// scene, because it rides the same shape of path and would otherwise drift
// through the camera frame above — two tokens in one frame is exactly the
// ambiguity the tight framing exists to remove.
const backScene = (await ok('add_scene', { projectId, name: 'Back', duration: 6, background: BG }))
  .data.sceneId
const backWire = (
  await ok('add_path', {
    projectId, sceneId: backScene, x: 300, y: 300,
    points: [
      { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 400 }, { x: 900, y: 400 },
      { x: 900, y: 700 },
    ],
    stroke: '#3a4450', strokeWidth: 4,
  })
).data.nodeId
const boomerang = (
  await ok('add_shape', {
    projectId, sceneId: backScene, shape: 'circle', x: 300, y: 300, radius: 20, fill: '#fc6255',
  })
).data.nodeId
const backAgain = await ok('flow_along', {
  projectId, sceneId: backScene, nodeId: boomerang, pathId: backWire,
  at: [{ t: 0, u: 0 }, { t: 2, u: 1 }, { t: 4, u: 0 }], easing: 'linear',
})
assert.match(backAgain.text, /reversing partway/, 'a profile that goes back must say so')
near(await posOf(backScene, boomerang, 2), [1200, 1000], 'out to the far end by 2s')
near(await posOf(backScene, boomerang, 4), [300, 300], 'and all the way back by 4s')

// ---------- 3c. the profile sampler must not drift from the keyframe one ----------
// sampleFlowU is deliberately a copy of sampleKeyframes over a scalar domain —
// written out because mapping FlowPoints to Keyframes would allocate on every
// follower on every frame. A copy nothing compares is a copy that diverges, so
// this compares them across the segment boundaries and between them.
const pts = [
  { t: 0, u: 0, easing: 'linear' as const },
  { t: 1, u: 0.75, easing: 'smooth' as const },
  { t: 4, u: 1, easing: 'easeOut' as const },
]
for (const t of [-1, 0, 0.3, 0.999, 1, 1.5, 2.5, 3.99, 4, 9]) {
  assert.strictEqual(
    sampleFlowU(pts, t),
    sampleKeyframes(pts.map((p) => ({ t: p.t, value: p.u, easing: p.easing })), t),
    `sampleFlowU and sampleKeyframes must agree at t=${t} — they are the same algorithm`,
  )
}

// ---------- 3d. a flat path and an orbiting camera disagree (plans/011 gap 6) ----------
// Run 8's off-orbit moon. A `path` is not projected per vertex: the stage draws
// it at its anchor's projected point scaled once by that anchor's perspective
// (stage.ts syncNode — `view.position.set(proj.x, proj.y)` and
// `view.scale.set(scale * proj.scale)`), while a follower is a node of its own
// and is projected at the scene point it actually occupies. The two agree only
// while the projection is affine over the curve.
//
// So the divergence is computable from the resolver's own numbers, and that is
// what makes the warning a fact rather than folklore: the only thing imported
// from the renderer is the one line quoted above.
const orbitScene = (await ok('add_scene', { projectId, name: 'Orbit', duration: 6, background: BG }))
  .data.sceneId
// An orbit ring, which is the shape run 8 hit this with — and the shape that
// makes the failure *visible*. A straight rail through the camera's focus
// diverges just as far, but along its own length, so the bead still appears to
// be on it; a first pass at this test measured 329px of drift and photographed
// a bead sitting neatly on its line.
const rail = (
  await ok('add_arc', {
    projectId, sceneId: orbitScene, x: 960, y: 540, rx: 500, ry: 250, samples: 64,
    stroke: '#3a4450', strokeWidth: 4,
  })
).data.nodeId
const bead = (
  await ok('add_shape', {
    projectId, sceneId: orbitScene, shape: 'circle', x: 1460, y: 540, radius: 20, fill: '#e8c74a',
  })
).data.nodeId

// No camera at all: nothing projects, so there is nothing to warn about and a
// warning here would be noise on the common case.
const flatFlow = await ok('flow_along', {
  projectId, sceneId: orbitScene, nodeId: bead, pathId: rail, start: 0, duration: 4,
})
assert.ok(
  !/WARNING: this scene both projects/.test(flatFlow.text),
  `a flow in a scene with no camera must not warn: ${flatFlow.text}`,
)

/** Both projected points, plus what the stage would draw the curve as. */
async function divergence(yaw: number): Promise<number> {
  await ok('set_camera', { projectId, sceneId: orbitScene, x: 960, y: 540, zoom: 1, yaw })
  const s = await ok('sample_at', { projectId, sceneId: orbitScene, t: 2, nodeIds: [bead, rail] })
  const nodes = s.data.nodes as {
    id: string
    world: { x: number; y: number }
    projection: { x: number; y: number; scale: number } | null
  }[]
  const b = nodes.find((n) => n.id === bead)!
  const p = nodes.find((n) => n.id === rail)!
  assert.ok(b.projection && p.projection, `both nodes must project at yaw ${yaw}`)
  // Where the stage puts the point of the curve the bead is riding.
  const drawnX = p.projection!.x + (b.world.x - p.world.x) * p.projection!.scale
  const drawnY = p.projection!.y + (b.world.y - p.world.y) * p.projection!.scale
  return Math.hypot(b.projection!.x - drawnX, b.projection!.y - drawnY)
}

const nearlyFlat = await divergence(0.05)
const turned = await divergence(0.9)
// Worth a picture, because the number is abstract and the failure is not: the
// camera is left at yaw 0.9, so this frame is the bead sitting well off the
// rail it is supposedly riding. It is the same thing run 8 saw as a moon off
// its orbit ring, and the reason the warning exists.
await inkAt(projectId, [(await sceneStart(projectId, orbitScene)) + 2], 'check-flows-orbit-drift.png')
assert.ok(
  turned > 30 && turned > nearlyFlat * 10,
  `the follower must part company with its drawn curve as the turn grows: ` +
    `${nearlyFlat.toFixed(1)}px at yaw 0.05 → ${turned.toFixed(1)}px at yaw 0.9. ` +
    `If these are equal the renderer has started projecting path points per vertex, ` +
    `and the warning below is now a lie that should be deleted.`,
)

// Both directions warn, because either call can create the clash. The camera
// is already turned, so this is the flow_along half.
const warnedFlow = await ok('flow_along', {
  projectId, sceneId: orbitScene, nodeId: bead, pathId: rail, start: 0, duration: 4,
})
assert.match(warnedFlow.text, /WARNING: this scene both projects/, 'flow_along warns under yaw')
assert.match(warnedFlow.text, new RegExp(`${bead} on ${rail}`), 'and names the pair')
// The useful half: which of the two is wrong, and a remedy that keeps the orbit.
assert.match(warnedFlow.text, /FOLLOWER is the correct one/, 'it says which one to trust')
assert.match(warnedFlow.text, /hide the path/, 'and offers a fix that does not cost the orbit')

// ...and the camera half, on a scene that already had the flow.
const warnedOrbit = await ok('orbit_camera', {
  projectId, sceneId: orbitScene, degrees: 40, start: 0, duration: 3,
})
assert.match(warnedOrbit.text, /WARNING: this scene both projects/, 'orbit_camera warns too')
const warnedSet = await ok('set_camera', { projectId, sceneId: orbitScene, x: 960, y: 540, pitch: 0.4 })
assert.match(warnedSet.text, /WARNING: this scene both projects/, 'and so does set_camera')

// A camera that never leaves the plane must stay quiet — the warning has to be
// about the combination, not about having a camera.
await ok('set_camera', { projectId, sceneId: orbitScene, reset: true })
const flatAgain = await ok('set_camera', { projectId, sceneId: orbitScene, x: 960, y: 540, zoom: 2 })
assert.ok(
  !/WARNING: this scene both projects/.test(flatAgain.text),
  `a flat camera over a flow must not warn: ${flatAgain.text}`,
)
// And a turning camera with nothing riding a path must stay quiet as well.
const emptyOrbit = await ok('orbit_camera', {
  projectId, sceneId: shapeScene, degrees: 90, start: 0, duration: 2,
})
assert.ok(
  !/WARNING: this scene both projects/.test(emptyOrbit.text),
  `an orbit with no follower must not warn: ${emptyOrbit.text}`,
)
console.log(
  `orbit/flow OK — divergence ${nearlyFlat.toFixed(1)}px → ${turned.toFixed(1)}px as yaw grows, ` +
    `both capabilities warn, and neither warns without the other`,
)

// ---------- 4. the errors teach ----------
const missing = await run('connect', { projectId, sceneId: shapeScene, from: a, to: 'nope_1234' })
assert.equal(missing.status, 400)
assert.match(missing.body, /does not exist in this scene/, 'a dangling anchor is refused up front')
assert.match(missing.body, /resolved every\s+frame/, 'and says why the id has to be real')

const selfLink = await run('connect', { projectId, sceneId: shapeScene, from: a, to: a })
assert.equal(selfLink.status, 400)
assert.match(selfLink.body, /no direction to point in/, 'an arrow to itself is refused')

// A path told to travel along itself — the type check passes, so this is the
// guard that has to catch it.
const selfPath = await run('flow_along', {
  projectId, sceneId: flowScene, nodeId: wire, pathId: wire, start: 0, duration: 1,
})
assert.equal(selfPath.status, 400)
assert.match(selfPath.body, /cannot travel along itself/, 'and so is a path following itself')

const wrongType = await run('flow_along', {
  projectId, sceneId: shapeScene, nodeId: a, pathId: b, start: 0, duration: 1,
})
assert.equal(wrongType.status, 400)
assert.match(wrongType.body, /not a path/, 'flowing along a non-path names what a path comes from')

// A position track loses to a flow, which is the opposite of the usual rule,
// so the response has to say so rather than leaving it to be discovered.
await ok('animate', {
  projectId, sceneId: flowScene, nodeId: token, property: 'position',
  to: { x: 100, y: 100 }, start: 0, duration: 1,
})
const shadowed = await ok('flow_along', {
  projectId, sceneId: flowScene, nodeId: token, pathId: wire, start: 1, duration: 4,
})
assert.match(shadowed.text, /also has a position track, and the flow wins/, 'the clash is reported')

// A profile carries its own timing, so start/duration alongside it would leave
// two answers to when the flow runs and no rule for which wins.
const both = await run('flow_along', {
  projectId, sceneId: flowScene, nodeId: paced, pathId: wire, start: 2,
  at: [{ t: 0, u: 0 }, { t: 1, u: 1 }],
})
assert.equal(both.status, 400)
assert.match(both.body, /cannot be combined with/, '`at` with `start` is refused')
assert.match(both.body, /moving the times in `at`/, 'and the refusal says how to shift the motion')

const neither = await run('flow_along', {
  projectId, sceneId: flowScene, nodeId: paced, pathId: wire,
})
assert.equal(neither.status, 400)
assert.match(neither.body, /give `start`.*or `at`/s, 'omitting both names the two forms')

// Descending times would silently run the motion backwards through a list the
// caller wrote forwards — and the fix is to lower `u`, not to reorder `t`,
// which is the part worth saying.
const backwards = await run('flow_along', {
  projectId, sceneId: flowScene, nodeId: paced, pathId: wire,
  at: [{ t: 0, u: 0 }, { t: 3, u: 1 }, { t: 2, u: 0.5 }],
})
assert.equal(backwards.status, 400)
assert.match(backwards.body, /ascending time order/, 'a descending profile is refused')
assert.match(backwards.body, /lower `u` at a LATER time/, 'and points at the way to go backwards')

// u is a fraction of the path, not a distance along it.
const overshoot = await run('flow_along', {
  projectId, sceneId: flowScene, nodeId: paced, pathId: wire,
  at: [{ t: 0, u: 0 }, { t: 1, u: 800 }],
})
assert.equal(overshoot.status, 400, 'u outside 0..1 must be refused, not clamped')

// ---------- 6. pinned nodes ignore the camera ----------
// Milestone run 6's caption drifted across the frame and grew 46% as the space
// orbited behind it, because a node at the scene root really is in the world.
// Two identical labels, one pinned: the camera zooms hard, and only the
// unpinned one is dragged with it. Measured with the camera framed off-centre
// so a label that moves leaves the frame entirely.
const pinScene = (await ok('add_scene', { projectId, name: 'Pinned', duration: 6, background: BG }))
  .data.sceneId
const pinned = (
  await ok('add_shape', {
    projectId, sceneId: pinScene, shape: 'circle', x: 300, y: 250, radius: 70, fill: '#ffffff',
  })
).data.nodeId
const loose = (
  await ok('add_shape', {
    projectId, sceneId: pinScene, shape: 'circle', x: 300, y: 830, radius: 70, fill: '#ffffff',
  })
).data.nodeId
const pinAt = (await sceneStart(projectId, pinScene)) + 1
const [bothInWorld] = await inkAt(projectId, [pinAt])
await ok('pin_to_frame', { projectId, sceneId: pinScene, nodeId: pinned })
// Zoom 3 about the canvas centre throws anything at x=300 far out of frame.
await ok('set_camera', { projectId, sceneId: pinScene, zoom: 3 })
const [afterPin] = await inkAt(projectId, [pinAt], 'check-flows-pinned.png')
assert.ok(
  afterPin! > 0.004 && afterPin! < bothInWorld! * 0.75,
  `exactly one disc should survive the zoom: ${pct(bothInWorld!)} → ${pct(afterPin!)}`,
)
// The real invariant is that the camera cannot touch it at all: pinned ink is
// the same under a zoom about the centre, a pan somewhere else, and an orbit.
// Note it is never *magnified* either — a pinned node keeps its own size, so
// the reading stays one unzoomed disc rather than growing with the zoom.
// With the unpinned disc gone, whatever the frame holds is the pinned one —
// an orbit does not throw it out of frame the way a hard zoom does, so leaving
// it in would have measured both.
await ok('remove_node', { projectId, sceneId: pinScene, nodeId: loose })
await ok('set_camera', { projectId, sceneId: pinScene, reset: true })
await ok('set_camera', { projectId, sceneId: pinScene, x: 300, y: 250, zoom: 3 })
const [panned] = await inkAt(projectId, [pinAt])
await ok('set_camera', { projectId, sceneId: pinScene, reset: true })
await ok('set_camera', { projectId, sceneId: pinScene, yaw: 0.9, pitch: 0.4 })
const [orbited] = await inkAt(projectId, [pinAt])
const oneDisc = (Math.PI * 70 * 70) / (1920 * 1080)
for (const [what, v] of [['zoomed', afterPin!], ['panned', panned!], ['orbited', orbited!]] as const) {
  assert.ok(
    Math.abs(v - oneDisc) < oneDisc * 0.15,
    `${what}: a pinned node keeps its own size and place — expected ~${pct(oneDisc)}, got ${pct(v)}`,
  )
}

const nested = await ok('add_group', { projectId, sceneId: pinScene, x: 900, y: 540 })
const kid = (
  await ok('add_shape', {
    projectId, sceneId: pinScene, shape: 'circle', x: 0, y: 0, radius: 30, fill: '#58c4dd',
    parentId: nested.data.nodeId,
  })
).data.nodeId
const nestedPin = await ok('pin_to_frame', { projectId, sceneId: pinScene, nodeId: kid })
assert.match(
  nestedPin.text,
  /inside a group, which still moves it/,
  'pinning a grouped child is a contradiction and says so rather than pretending',
)

// ---------- 7. an arrow can point at one cell ----------
// Run 6 needed six proxy circles to draw six per-token arrows. This is the
// call it should have been able to make.
const cellScene = (await ok('add_scene', { projectId, name: 'Cells', duration: 6, background: BG }))
  .data.sceneId
const strip = (
  await ok('add_tokens', {
    projectId, sceneId: cellScene, labels: ['alpha', 'beta', 'gamma', 'delta'],
    x: 960, y: 300, fontSize: 44, cellWidth: 300, boxStroke: '#3a4450',
  })
).data.nodeId
const sink = (
  await ok('add_shape', {
    projectId, sceneId: cellScene, shape: 'circle', x: 960, y: 860, radius: 70, fill: '#1b2733',
    stroke: '#e8c74a',
  })
).data.nodeId
// One arrow, from the FIRST token. The two frames below are mirror images of
// each other either side of the strip's centre, and neither contains a token
// box — so the only thing that can light one and not the other is where the
// arrow actually leaves from. (Framing on the tokens themselves measured the
// boxes, which dominate the ink and say nothing about the anchor.)
await ok('connect', {
  projectId, sceneId: cellScene, from: { node: strip, cells: { cols: 0 } }, to: sink,
  stroke: '#7fb069', strokeWidth: 6,
})
const cellAt = (await sceneStart(projectId, cellScene)) + 3
await ok('set_camera', { projectId, sceneId: cellScene, x: 735, y: 565, zoom: 4 })
const [underFirst] = await inkAt(projectId, [cellAt], 'check-flows-cells.png')
await ok('set_camera', { projectId, sceneId: cellScene, reset: true })
await ok('set_camera', { projectId, sceneId: cellScene, x: 1185, y: 565, zoom: 4 })
const [underLast] = await inkAt(projectId, [cellAt])
assert.ok(
  underFirst! > underLast! * 3 && underFirst! > 0.01,
  `an arrow anchored to col 0 must leave from col 0: ${pct(underFirst!)} under the first ` +
    `token vs ${pct(underLast!)} under the last`,
)

// Anchor a second arrow to the LAST token and the mirror frame lights up too,
// which is the same claim from the other side.
await ok('connect', {
  projectId, sceneId: cellScene, from: { node: strip, cells: { cols: 3 } }, to: sink,
  stroke: '#7fb069', strokeWidth: 6,
})
const [underLastNow] = await inkAt(projectId, [cellAt])
assert.ok(
  underLastNow! > underLast! * 3,
  `and one anchored to col 3 lights the other side: ${pct(underLast!)} → ${pct(underLastNow!)}`,
)

const badCell = await run('connect', {
  projectId, sceneId: cellScene, from: { node: strip, cells: { cols: 9 } }, to: sink,
})
assert.equal(badCell.status, 400)
assert.match(badCell.body, /outside .* which is 1x4/, 'a cell the strip does not have is refused')

// ---------- 5. a flow is a key moment ----------
const sheet = await ok('preview_frames', { projectId })
writeFileSync(`${OUT}/check-flows-sheet.png`, Buffer.from(sheet.image!.base64, 'base64'))
assert.ok(
  (sheet.data.moments as { kind: string }[]).some((m) => m.kind === 'follow'),
  'mid-flight is a frame worth capturing, so a flow is a key moment',
)

await ok('delete_project', { projectId, confirm: true })

console.log(
  `flows OK — tracking ${pct(before!)} → ${pct(after!)} with the camera on the corridor the ` +
    `arrow must stretch across, curved pair ${pct(pair!)} vs straight ${pct(straight!)}, ` +
    `path travel ${travel.map(pct).join('→')}, pinned ${pct(afterPin!)}/${pct(panned!)}/` +
    `${pct(orbited!)} under three cameras, cell anchor ${pct(underFirst!)} vs ` +
    `${pct(underLast!)} on the wrong side. Speed profile lands on the arc length it names ` +
    `(1100,700) at 1s where a constant flow is 500px behind — ` +
    `${pct(wireOnly!)}/${pct(paceArrives!)}/${pct(gone!)} through a frame at that point — ` +
    `interpolates between its points, reverses, and samples identically to sampleKeyframes. ` +
    `Dangling, self-link, wrong-type, out-of-range cell, grouped-pin, track-shadowing, ` +
    `at-with-start, neither, descending and out-of-range u messages all teach. ` +
    `Frames in ${OUT}/check-flows-*.png`,
)
