/**
 * The agent gateway: instructions → describe → execute, driven the way the MCP
 * worker will drive it.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-gateway.ts
 *
 * Free — no credits, and it never calls a paid capability. Needs `dev:api`.
 *
 * What it is really testing is the claim the gateway is built on: that three
 * fixed tools can carry a catalog that changes underneath them. So it checks
 * not just that a capability runs, but that the *errors* teach — an unknown
 * name, a bad argument and a paid call through the free executor each have to
 * come back with the remedy, because after this refactor the error text is the
 * only documentation an agent gets.
 */
import './load-env'
import assert from 'node:assert'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }

async function get(path: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${API}${path}`, { headers: H })
  return { status: res.status, body: await res.text() }
}

async function post(path: string, body: unknown): Promise<{ status: number; body: string }> {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
  return { status: res.status, body: await res.text() }
}

/** Run a free capability, asserting it succeeded. */
async function exec(name: string, args: Record<string, unknown>): Promise<string> {
  const r = await post(`/api/agent/tools/${name}/execute`, args)
  assert.equal(r.status, 200, `${name} should succeed, got ${r.status}: ${r.body}`)
  return r.body
}

// ---------- tool 1: instructions ----------
const instructions = await get('/api/agent/tools')
assert.equal(instructions.status, 200, 'instructions must be readable')
for (const required of ['create_project', 'animate', 'morph_latex', 'render_video', 'update_node']) {
  assert.ok(instructions.body.includes(required), `instructions must list ${required}`)
}
// The paid split is the whole credit-safety story; it has to be visible here.
assert.match(instructions.body, /PAID CAPABILITIES/, 'instructions must separate paid capabilities')
assert.match(instructions.body, /execute_paid/, 'instructions must name the paid executor')

const listed = JSON.parse((await get('/api/agent/tools?format=json')).body) as {
  revision: string
  capabilities: { name: string; costsCredits: boolean }[]
}
const paid = listed.capabilities.filter((x) => x.costsCredits).map((x) => x.name).sort()
// A tripwire on the money surface: changing what costs credits should be a
// deliberate edit here, not a side effect of adding a capability.
assert.deepStrictEqual(
  paid,
  [
    'generate_3d',
    'generate_audio',
    'generate_image',
    'generate_narration',
    'generate_video',
    'render_video',
  ],
  'the credit-spending capabilities must be exactly these',
)

// The orientation prose must COUNT the paid capabilities, not claim a number.
// It said "the two capabilities" for a while after the generate_* family landed
// — the third time hand-written prose in this block went stale (plans/009,
// milestone run 7), and the reason the node list and every capability name in
// it are now derived rather than typed.
const claimed = instructions.body.match(/free except the (\d+) capabilit/)
assert.ok(claimed, 'the COST paragraph must state how many capabilities are paid')
assert.equal(
  Number(claimed[1]),
  paid.length,
  `instructions claim ${claimed[1]} paid capabilities but the catalog has ${paid.length}. ` +
    `That number is derived — if this fails, someone hardcoded it again.`,
)

// Every node type the DSL can express must be described in the orientation.
// The Record in execute.ts is keyed by EuclidNode['type'], so this cannot fail
// without someone deleting the mechanism; it is here to say so if they do.
for (const phrase of ['shapes', 'matrix and tokens', 'vector3/axes3d/points3', 'mesh']) {
  assert.ok(
    instructions.body.includes(phrase),
    `orientation must describe ${phrase} — a node type an agent cannot know about is one it cannot use`,
  )
}
console.log(`instructions OK — ${listed.capabilities.length} capabilities, revision ${listed.revision}`)

// ---------- tool 2: describe ----------
const described = await post('/api/agent/tools/describe', { names: ['animate', 'update_node'] })
assert.equal(described.status, 200, 'describe must work')
// The prose that exists because real runs failed without it must survive.
assert.match(described.body, /sampled from the document/, 'animate must explain its start value')
assert.match(described.body, /the track wins/, 'update_node must keep the shadowing warning')
assert.match(described.body, /"position"/, 'update_node must show the nested position form')

const unknownName = await post('/api/agent/tools/describe', { names: ['animat'] })
assert.equal(unknownName.status, 404, 'an unknown name must fail, not be skipped')
assert.match(unknownName.body, /Did you mean.*animate/, 'a near-miss must be suggested')
console.log('describe OK — behavioural prose and near-miss suggestions intact')

// ---------- tool 3: execute ----------
const project = JSON.parse(
  (await post('/api/agent/tools/create_project/execute?format=json', { name: 'Gateway Check' })).body,
) as { data: { id: string } }
const projectId = project.data.id

const sceneText = await exec('add_scene', { projectId, name: 'S', duration: 5 })
const sceneId = sceneText.match(/scene (\S+)/)![1]!
const nodeText = await exec('add_text', { projectId, sceneId, textContent: 'hi', x: 960, y: 540 })
const nodeId = nodeText.match(/node (\S+)/)![1]!
console.log('fixture ready:', projectId)

// The stringified-number habit that broke a milestone run must still be handled
// now that validation is server-side.
await exec('animate', { projectId, sceneId, nodeId, property: 'opacity', to: '1.12', start: 0, duration: 1 })
await exec('animate', { projectId, sceneId, nodeId, property: 'position', to: { x: '100', y: '200' }, start: 0, duration: 1 })

const doc = (await (await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })).json()) as {
  doc: { scenes: { nodes: { tracks: { property: string; keyframes: { value: unknown }[] }[] }[] }[] }
}
const byProp = Object.fromEntries(
  doc.doc.scenes[0]!.nodes[0]!.tracks.map((t) => [t.property, t.keyframes.at(-1)!.value]),
)
assert.strictEqual(byProp.opacity, 1.12, 'stringified number must be stored as a number')
assert.deepStrictEqual(byProp.position, { x: 100, y: 200 }, 'stringified coords must become numbers')

// ...and nonsense must still be refused rather than coerced to 0.
for (const bad of ['abc', '', true, null, []]) {
  const r = await post(`/api/agent/tools/animate/execute`, {
    projectId, sceneId, nodeId, property: 'opacity', to: bad, start: 0, duration: 1,
  })
  assert.equal(r.status, 400, `animate must reject ${JSON.stringify(bad)}, got ${r.status}`)
}
console.log('execute OK — arg coercion accepted, nonsense rejected, real numbers in the document')

// ---------- the errors, which are now the only documentation ----------
const badArgs = await post('/api/agent/tools/animate/execute', { projectId, sceneId, nodeId })
assert.equal(badArgs.status, 400)
assert.match(badArgs.body, /invalid arguments for animate/, 'a bad call must name the capability')
assert.match(badArgs.body, /describe/, 'a bad call must point at describe')

const unknownCap = await post('/api/agent/tools/anmiate/execute', {})
assert.equal(unknownCap.status, 404)
assert.match(unknownCap.body, /instructions/, 'an unknown capability must point back at instructions')

// The credit gate: a paid capability must refuse the free executor outright,
// so a standing approval on `execute` can never authorise a charge.
const sneaky = await post('/api/agent/tools/render_video/execute', { projectId })
assert.equal(sneaky.status, 403, 'render_video must refuse the free executor')
assert.match(sneaky.body, /execute_paid/, 'the refusal must name the paid executor')

// And the inverse, so the split cannot be worked around by always using _paid.
const wrongWay = await post('/api/agent/tools/get_project/execute?paid=1', { projectId })
assert.equal(wrongWay.status, 400, 'a free capability must refuse the paid executor')

// The trap that cost a milestone run: a patch of top-level x/y changed nothing
// and reported success. It must now be rejected outright.
const flatXY = await post('/api/agent/tools/update_node/execute', {
  projectId, sceneId, nodeId, patch: { x: 10, y: 20 },
})
assert.equal(flatXY.status, 422, 'a top-level x/y patch must be rejected')
assert.match(flatXY.body, /position/, 'the rejection must show the nested position form')

// The second trap: patching a property an animation keyframes changes the
// document but not the render, and must say so.
const shadowed = await exec('update_node', {
  projectId, sceneId, nodeId, patch: { position: { x: 5, y: 5 } },
})
assert.match(shadowed, /animated on this node/, 'a shadowed patch must warn')
console.log('errors OK — bad args, unknown names, credit gate and both update_node traps')

// ---------- an argument the capability does not have is an ERROR ----------
// Zod strips unknown keys by default, which turns a typo into a success:
// milestone run 4 passed `tail:` to fit_scene_to_narration three times and got
// the 0.8s default reported back each time as though it were the value asked
// for. That is the update_node trap in a second place, and it was found by
// luck — the response happened to print the tail it used.
//
// Enforced centrally in the executor, so these cases stand in for all of the
// catalog: a capability cannot opt out, and a new one cannot forget.
for (const [name, args, bad] of [
  ['add_scene', { projectId, name: 'T', duration: 3, bckground: '#ff0000' }, 'bckground'],
  ['animate', { projectId, sceneId, nodeId, property: 'opacity', to: 0, start: 0, duration: 1, ease: 'linear' }, 'ease'],
  ['highlight', { projectId, sceneId, nodeId, start: 0, duration: 1, colour: '#ff0000' }, 'colour'],
  ['fit_scene_to_narration', { projectId, sceneId, tail: 1.2 }, 'tail'],
  ['preview_frames', { projectId, times: [1, 2] }, 'times'],
] as const) {
  const r = await post(`/api/agent/tools/${name}/execute`, args)
  assert.equal(r.status, 400, `${name} must reject the unknown argument "${bad}", got ${r.status}`)
  assert.match(r.body, new RegExp(`unknown argument.*\`${bad}\``), `${name} must name "${bad}"`)
  // Naming what *was* expected is the whole point: the mistake is nearly
  // always a near-miss for a real argument.
  assert.match(r.body, /Accepts: /, `${name}'s refusal must list the arguments it does take`)
}
// The correct spelling still works — strictness must not cost a valid call.
assert.match(
  await exec('highlight', { projectId, sceneId, nodeId, start: 0, duration: 1, color: '#ff0000' }),
  /highlighting/,
  'a correctly-spelled argument is unaffected',
)
console.log('unknown args OK — rejected by name across the catalog, valid calls unaffected')

// ---------- rotation is radians, and says so ----------
// `animate` reported `rotation 0 → 11.46` truthfully in run 4 and was wrong by
// 25x: the agent sent degrees. The value is correct as far as the document is
// concerned, so only the units documentation can prevent it.
const rot = await post('/api/agent/tools/describe', { names: ['animate'] })
assert.match(rot.body, /RADIANS/, 'animate must state the unit of rotation')
assert.match(rot.body, /1\.5708|π/, 'and give a conversion the caller can use')
assert.match(
  (await get('/api/agent/tools')).body,
  /rotation in radians/,
  'the one-line summary must carry it too — most calls never reach describe',
)

// ---------- capabilities that only read ----------
const outline = await exec('get_project', { projectId })
assert.match(outline, /scene sc_/, 'get_project must outline scenes')
await exec('set_narration', { projectId, sceneId, narrationText: 'One two three.' })
const captions = await exec('get_captions', { projectId, format: 'srt' })
assert.match(captions, /One two three/, 'captions must derive from narration text alone')

// ---------- every remaining capability ----------
// These were ported by hand out of the MCP worker, which makes them exactly the
// ones worth running: a silent slip here would surface as a failed milestone
// run and get blamed on the gateway rather than on the port.

assert.match(await exec('list_projects', {}), new RegExp(projectId), 'list_projects must list it')
assert.match(await exec('get_scene', { projectId, sceneId }), /"nodes"/, 'get_scene returns JSON')
assert.match(
  await exec('update_scene', { projectId, sceneId, duration: 8 }),
  /"duration":8/,
  'update_scene must report the patch it applied',
)

// Node constructors — each builds its node shape in a separate branch.
const eqId = (await exec('add_latex', { projectId, sceneId, tex: 'a^2+b^2', x: 960, y: 400 }))
  .match(/node (\S+)/)![1]!
const rectId = (await exec('add_shape', { projectId, sceneId, shape: 'rect', x: 100, y: 100 }))
  .match(/node (\S+)/)![1]!
const circleId = (await exec('add_shape', { projectId, sceneId, shape: 'circle', x: 200, y: 200, radius: 50 }))
  .match(/node (\S+)/)![1]!
const lineId = (await exec('add_shape', { projectId, sceneId, shape: 'line', x: 0, y: 0, x2: 300, y2: 40 }))
  .match(/node (\S+)/)![1]!

// Transitions, and the overlap-replace rule they share. Re-calling to revise a
// morph must replace it, not stack a second one whose source would be a
// half-finished equation.
await exec('morph_latex', { projectId, sceneId, nodeId: eqId, toTex: 'c^2', start: 1, duration: 1 })
assert.match(
  await exec('morph_latex', { projectId, sceneId, nodeId: eqId, toTex: 'd^2', start: 1.5, duration: 1 }),
  /replaced 1 overlapping morph/,
  'an overlapping morph must replace, not stack',
)
await exec('write_on', { projectId, sceneId, nodeId: eqId, start: 0, duration: 1 })
await exec('highlight', { projectId, sceneId, nodeId: eqId, start: 3, duration: 1, tex: 'a^2' })
assert.match(
  await exec('highlight', { projectId, sceneId, nodeId: eqId, start: 3.5, duration: 1 }),
  /replaced 1 overlapping/,
  'an overlapping highlight must replace, matching morph',
)
// Non-overlapping highlights accumulate instead — that is what lets narration
// walk through several terms of one equation in turn.
assert.doesNotMatch(
  await exec('highlight', { projectId, sceneId, nodeId: eqId, start: 6, duration: 1 }),
  /replaced/,
  'a non-overlapping highlight must accumulate',
)
// tex targeting is latex-only, and the refusal must say what to do instead.
const texOnShape = await post('/api/agent/tools/highlight/execute', {
  projectId, sceneId, nodeId: rectId, start: 0, duration: 1, tex: 'x',
})
assert.equal(texOnShape.status, 400)
assert.match(texOnShape.body, /Omit tex/, 'the refusal must name the way forward')

// What actually landed, rather than what was reported.
const eqScene = JSON.parse(await exec('get_scene', { projectId, sceneId })) as {
  nodes: { id: string; transitions: { type: string }[] }[]
}
const eq = eqScene.nodes.find((n) => n.id === eqId)!
const kinds = eq.transitions.map((t) => t.type).sort()
assert.deepStrictEqual(
  kinds,
  ['highlight', 'highlight', 'texMorph', 'write'],
  `expected one morph, one write and two highlights, got ${kinds.join(',')}`,
)

await exec('remove_node', { projectId, sceneId, nodeId: lineId })
assert.ok(
  !(await exec('get_project', { projectId })).includes(lineId),
  'remove_node must actually remove it',
)

// fit_scene_to_narration needs real audio, so without it the error has to name
// the capability that produces one.
const unfittable = await post('/api/agent/tools/fit_scene_to_narration/execute', { projectId, sceneId })
assert.equal(unfittable.status, 400)
assert.match(unfittable.body, /generate_narration/, 'it must name the missing prerequisite')

assert.match(await exec('get_render_status', { projectId }), /no render jobs/, 'no jobs yet')

// The paid executor's plumbing, without spending anything: a scene with no
// narration text fails validation *before* the debit, so this exercises the
// paid path end to end for free.
const emptyScene = (await exec('add_scene', { projectId, name: 'Silent', duration: 2 }))
  .match(/scene (\S+)/)![1]!
const paidPath = await post(
  '/api/agent/tools/generate_narration/execute?paid=1',
  { projectId, sceneId: emptyScene },
)
assert.equal(paidPath.status, 400, 'the paid executor must reach the capability')
assert.match(paidPath.body, /set_narration/, 'and fail with the remedy, before any charge')
console.log('capabilities OK — nodes, transitions, overlap-replace, and the paid path (unspent)')

// ---------- path: one node for a curve ----------
// Run 4 built a parabola as 9 separate `line` nodes — 9 of that scene's 22.
const curve = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: -(((i / 39) * 2) ** 2) * 100 }))
const pathId = (await exec('add_path', { projectId, sceneId, points: curve, x: 200, y: 800 }))
  .match(/node (\S+)/)![1]!
const withPath = JSON.parse(await exec('get_scene', { projectId, sceneId })) as {
  nodes: { id: string; type: string; points?: unknown[]; closed?: boolean }[]
}
const stored = withPath.nodes.find((n) => n.id === pathId)!
assert.equal(stored.type, 'path', 'a curve is one node, not one per segment')
assert.equal(stored.points!.length, 40, 'every sample is kept')
assert.equal(stored.closed, false, 'a plotted curve is open by default')

// Two points is the floor: one point is a dot, which is a circle.
const tooFew = await post('/api/agent/tools/add_path/execute', {
  projectId, sceneId, points: [{ x: 0, y: 0 }],
})
assert.equal(tooFew.status, 400, 'a one-point path must be refused')

// The stringified-number habit reaches nested arrays too.
assert.match(
  await exec('add_path', { projectId, sceneId, points: [{ x: '0', y: '0' }, { x: '50', y: '25' }] }),
  /created path node/,
  'points accept the stringified numbers a real client sends',
)
console.log('path OK — one node per curve, samples preserved, degenerate input refused')

// ---------- plot_function: the mapping must be usable ----------
// Run 4's costly mistake was the coordinate mapping, not the drawing. So the
// thing worth pinning is that the transform this reports back is the one it
// actually used — otherwise a caller placing a point "on the curve" using
// those numbers lands beside it, which is invisible in text and obvious only
// in a picture.
const plotted = JSON.parse(
  (await post('/api/agent/tools/plot_function/execute?format=json', {
    projectId, sceneId, expression: 'x^2', xMin: 0, xMax: 2,
    x: 100, y: 100, width: 400, height: 300, samples: 41,
  })).body,
) as { text: string; data: { nodeId: string; points: { x: number; y: number }[]
       originScreen: { x: number; y: number }; scale: { x: number; y: number } } }
assert.equal(plotted.data.points.length, 41, 'every sample is plotted')
assert.match(plotted.text, /Mapping: function \(0,0\)/, 'the mapping is reported, not just used')

// x=1 is sample 20 of 41 over [0,2]; y=1 there.
const onCurve = plotted.data.points[20]!
assert.ok(
  Math.abs(plotted.data.originScreen.x + 1 * plotted.data.scale.x - onCurve.x) < 1e-6 &&
    Math.abs(plotted.data.originScreen.y - 1 * plotted.data.scale.y - onCurve.y) < 1e-6,
  'the reported mapping must reproduce a plotted point exactly',
)
// Canvas y grows downward: the curve's high end must be *higher* on screen.
assert.ok(
  plotted.data.points.at(-1)!.y < plotted.data.points[0]!.y,
  'y must be flipped for the canvas, or the parabola renders upside down',
)

// The expression errors have to name the fix, like every other error here.
const implicitMul = await post('/api/agent/tools/plot_function/execute', {
  projectId, sceneId, expression: '2x', xMin: 0, xMax: 1, x: 0, y: 0, width: 10, height: 10,
})
assert.equal(implicitMul.status, 400)
assert.match(implicitMul.body, /2\*x/, 'implicit multiplication is refused with the correction')

const noSuchFn = await post('/api/agent/tools/plot_function/execute', {
  projectId, sceneId, expression: 'wibble(x)', xMin: 0, xMax: 1, x: 0, y: 0, width: 10, height: 10,
})
assert.equal(noSuchFn.status, 400)
assert.match(noSuchFn.body, /Available: .*sqrt/, 'an unknown function lists the real ones')

// Nothing outside the whitelist is reachable — the reason this is its own
// grammar rather than anything touching the JS evaluator.
for (const hostile of ['Math.random()', 'globalThis', 'x)+(1']) {
  const r = await post('/api/agent/tools/plot_function/execute', {
    projectId, sceneId, expression: hostile, xMin: 0, xMax: 1, x: 0, y: 0, width: 10, height: 10,
  })
  assert.equal(r.status, 400, `"${hostile}" must be refused`)
}
console.log('plot OK — mapping round-trips, y flipped for canvas, expression errors teach')

// ---------- groups carry their children ----------
// The hierarchy existed in the document and the renderer all along; nothing
// exposed it, so run 5 keyframed an orbiting dot as 16 chords per revolution
// and spent ~60% of its calls doing it. One animate on a group replaces that.
const grpId = (await exec('add_group', { projectId, sceneId, x: 700, y: 540 }))
  .match(/group (\S+)/)![1]!
await exec('add_shape', {
  projectId, sceneId, shape: 'circle', x: 200, y: 0, radius: 14, parentId: grpId,
})
const nested = JSON.parse(await exec('get_scene', { projectId, sceneId })) as {
  nodes: { id: string; type: string; children?: { id: string; position: { x: number } }[] }[]
}
const grp = nested.nodes.find((n) => n.id === grpId)!
assert.equal(grp.type, 'group')
assert.equal(grp.children!.length, 1, 'parentId must nest the child, not add it to the scene root')
assert.equal(grp.children![0]!.position.x, 200, "a child's coordinates stay relative to the group")
assert.ok(
  !nested.nodes.some((n) => n.id === grp.children![0]!.id),
  'a nested child must not also appear at the scene root',
)
// A group is animatable like any node — that is the entire point.
assert.match(
  await exec('animate', {
    projectId, sceneId, nodeId: grpId, property: 'rotation', to: 6.283, start: 0, duration: 5,
  }),
  /rotation/,
  'a group rotates, carrying its children',
)
// Nested nodes stay addressable, or a child could never be edited again.
assert.match(
  await exec('update_node', {
    projectId, sceneId, nodeId: grp.children![0]!.id, patch: { radius: 20 },
  }),
  /updated/,
  'a child inside a group is still findable by id',
)
const badParent = await post('/api/agent/tools/add_shape/execute', {
  projectId, sceneId, shape: 'circle', x: 0, y: 0, parentId: 'grp_nope',
})
assert.equal(badParent.status, 422, 'an unknown parent must be refused, not silently ignored')
console.log('groups OK — children nest, inherit the transform, and stay addressable')

// ---------- draw order is document order, and now it is editable ----------
// Run 8 deleted and rebuilt two whole scenes to put a backdrop behind what was
// already there, which also destroyed the transitions bound to the removed ids.
// The assertion that matters is not that a node moved: it is that the move is
// atomic and lossless — everything attached to the node has to survive it, or
// this is just a slower rebuild.
const orderScene = (await exec('add_scene', { projectId, name: 'Order', duration: 5 }))
  .match(/scene (\S+)/)![1]!
const backA = (await exec('add_shape', { projectId, sceneId: orderScene, shape: 'circle', x: 300, y: 300 }))
  .match(/node (\S+)/)![1]!
const backB = (await exec('add_shape', { projectId, sceneId: orderScene, shape: 'rect', x: 400, y: 300 }))
  .match(/node (\S+)/)![1]!
const drop = (await exec('add_text', { projectId, sceneId: orderScene, textContent: 'sky', x: 960, y: 540 }))
  .match(/node (\S+)/)![1]!
// The thing a rebuild destroys: a transition bound to this id.
await exec('write_on', { projectId, sceneId: orderScene, nodeId: drop, start: 0, duration: 1 })

const sceneOrder = async (): Promise<string[]> =>
  (JSON.parse(await exec('get_scene', { projectId, sceneId: orderScene })) as {
    nodes: { id: string }[]
  }).nodes.map((n) => n.id)

assert.deepStrictEqual(await sceneOrder(), [backA, backB, drop], 'creation order is draw order')
await exec('reorder_node', { projectId, sceneId: orderScene, nodeId: drop, to: 'back' })
assert.deepStrictEqual(await sceneOrder(), [drop, backA, backB], '"back" must put it behind everything')

// The transition has to have come along. A rebuild is what loses this.
const kept = (JSON.parse(await exec('get_scene', { projectId, sceneId: orderScene })) as {
  nodes: { id: string; transitions: { type: string }[] }[]
}).nodes.find((n) => n.id === drop)!
assert.equal(kept.transitions.length, 1, 'moving a node must not drop its transitions')
assert.equal(kept.transitions[0]!.type, 'write', 'the write-on must still be the one that was set')

// before/after are relative to the *other* node, counted in the list as it will
// be — the off-by-one that a naive splice gets wrong when the anchor sits after
// the node in its own list.
await exec('reorder_node', { projectId, sceneId: orderScene, nodeId: drop, after: backB })
assert.deepStrictEqual(await sceneOrder(), [backA, backB, drop], '"after" must land directly in front')
await exec('reorder_node', { projectId, sceneId: orderScene, nodeId: drop, before: backA })
assert.deepStrictEqual(await sceneOrder(), [drop, backA, backB], '"before" must land directly behind')

// Re-parenting, and the refusals. A group moved inside its own descendant would
// detach both from the scene — the document still validates, because the cycle
// is simply unreachable, so nothing downstream would have caught it.
const outer = (await exec('add_group', { projectId, sceneId: orderScene, x: 100, y: 100 }))
  .match(/group (\S+)/)![1]!
const inner = (await exec('add_group', { projectId, sceneId: orderScene, x: 50, y: 50, parentId: outer }))
  .match(/group (\S+)/)![1]!
const cycle = await post('/api/agent/tools/reorder_node/execute', {
  projectId, sceneId: orderScene, nodeId: outer, to: 'back', parentId: inner,
})
assert.equal(cycle.status, 422, 'a group must not be moved inside its own descendant')
assert.match(cycle.body, /detach/, 'the refusal must say what it would have done')

const reparented = await exec('reorder_node', {
  projectId, sceneId: orderScene, nodeId: drop, to: 'front', parentId: outer,
})
assert.match(reparented, /re-parented/, 're-parenting must say the node moved on screen')
assert.ok(!(await sceneOrder()).includes(drop), 'a re-parented node leaves the root')
await exec('reorder_node', { projectId, sceneId: orderScene, nodeId: drop, to: 'front', parentId: 'root' })
assert.ok((await sceneOrder()).includes(drop), '"root" must move it back out')

// Placements that disagree are an error rather than a silent precedence rule —
// the same principle as an unrecognised argument being rejected.
for (const [args, why] of [
  [{}, 'no placement'],
  [{ to: 'back', index: 2 }, 'two placements'],
  [{ before: drop }, 'relative to itself'],
  [{ to: 'front', parentId: backA }, 'a non-group parent'],
] as [Record<string, unknown>, string][]) {
  const r = await post('/api/agent/tools/reorder_node/execute', {
    projectId, sceneId: orderScene, nodeId: drop, ...args,
  })
  assert.equal(r.status, 400, `reorder_node must refuse ${why}, got ${r.status}: ${r.body}`)
}
console.log('reorder OK — back/front/before/after, re-parenting, cycle and ambiguity refused')

// ---------- resolved state, readable without pixels ----------
// The sampler is a pure function of (document, time) and the surface exposed it
// only as the raw document or as a picture. Run 8 computed a crossing window by
// arithmetic over its own keyframes, got it wrong, and corrected it from tiles.
// So the assertion is a number the caller could NOT have read off the document:
// a child of a rotated group, and the same point after a camera framed it.
const sampleScene = (await exec('add_scene', { projectId, name: 'Sample', duration: 10 }))
  .match(/scene (\S+)/)![1]!
const pivot = (await exec('add_group', { projectId, sceneId: sampleScene, x: 400, y: 300 }))
  .match(/group (\S+)/)![1]!
const rider = (await exec('add_shape', {
  projectId, sceneId: sampleScene, shape: 'circle', x: 200, y: 0, radius: 20, parentId: pivot,
})).match(/node (\S+)/)![1]!
// A quarter turn over 4s, linear, so t=4 is exactly π/2 and the answer is exact.
await exec('animate', {
  projectId, sceneId: sampleScene, nodeId: pivot,
  property: 'rotation', to: Math.PI / 2, start: 0, duration: 4, easing: 'linear',
})

const sampled = async (t: number, nodeIds?: string[]): Promise<{
  nodes: { id: string; world: { x: number; y: number }; screen: { x: number; y: number }; visible: boolean }[]
}> =>
  JSON.parse(
    (await post(`/api/agent/tools/sample_at/execute?format=json`, {
      projectId, sceneId: sampleScene, t, ...(nodeIds ? { nodeIds } : {}),
    })).body,
  ).data

const at0 = (await sampled(0)).nodes.find((n) => n.id === rider)!
assert.deepStrictEqual(at0.world, { x: 600, y: 300 }, "a child's world position folds in its group")

// The one that cannot be read off the document at all: (200, 0) rotated a
// quarter turn about (400, 300) is (400, 500), and the document says (200, 0).
const at4 = (await sampled(4)).nodes.find((n) => n.id === rider)!
assert.ok(
  Math.abs(at4.world.x - 400) < 0.01 && Math.abs(at4.world.y - 500) < 0.01,
  `a rotated group must move its child: expected (400, 500), got (${at4.world.x}, ${at4.world.y})`,
)
// With no camera, scene coordinates ARE screen coordinates.
assert.deepStrictEqual(at4.screen, at4.world, 'without a camera the two must agree exactly')

// And with one: centre + zoom * (p − position) = 960 + 2*(400−960) = −160.
await exec('set_camera', { projectId, sceneId: sampleScene, x: 960, y: 540, zoom: 2 })
const framed = (await sampled(4, [rider])).nodes.find((n) => n.id === rider)!
assert.deepStrictEqual(
  framed.screen,
  { x: -160, y: 460 },
  'the camera transform must be applied, and reported',
)
assert.equal(framed.visible, false, 'a node framed off the canvas must be reported as not drawn')
assert.match(
  await exec('sample_at', { projectId, sceneId: sampleScene, t: 4, nodeIds: [rider] }),
  /OFF-FRAME/,
  'the text must name why it is not drawn',
)
// Past the end still answers — tracks hold — but it must say the moment is
// never rendered, or an agent reads timings for a frame that does not exist.
assert.match(
  await exec('sample_at', { projectId, sceneId: sampleScene, t: 99 }),
  /past this scene's/,
  'a time past the scene end must be flagged',
)
const noSuch = await post('/api/agent/tools/sample_at/execute', {
  projectId, sceneId: sampleScene, t: 0, nodeIds: ['nope_1'],
})
assert.equal(noSuch.status, 404, 'an unknown node must fail rather than return an empty listing')
console.log('sample_at OK — group composition, camera framing and off-frame reported without pixels')

// ---------- an unfilled shape is an outline, not a hole ----------
// Filling with the background colour was the only way to get a ring, which
// paints an opaque disc over whatever is behind it.
const ringId = (await exec('add_shape', {
  projectId, sceneId, shape: 'circle', x: 400, y: 400, radius: 90,
  fill: 'none', stroke: '#5b6673', strokeWidth: 3,
})).match(/node (\S+)/)![1]!
const ring = (JSON.parse(await exec('get_scene', { projectId, sceneId })) as {
  nodes: { id: string; fill?: string; stroke?: string }[]
}).nodes.find((n) => n.id === ringId)!
assert.equal(ring.fill, undefined, '"none" must omit the fill, not store a colour')
assert.equal(ring.stroke, '#5b6673', 'the outline is still drawn')
console.log('fill OK — "none" gives a real outline rather than a background-coloured disc')

// ---------- assets ----------
// Producers are server-side, so the fixture is uploaded the way TTS does it.
const uploaded = JSON.parse(
  await (
    await fetch(`${API}/api/projects/${projectId}/assets?kind=audio&durationSec=1.5`, {
      method: 'POST',
      headers: { 'x-internal-key': KEY, 'x-user-id': 'dev-user', 'content-type': 'audio/mpeg' },
      body: new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x01, 0x02, 0x03]),
    })
  ).text(),
) as { assetId: string }

const tree = await exec('list_assets', { projectId })
assert.match(tree, /\[unused\]/, 'an unreferenced asset must read as unused')
assert.match(await exec('move_asset', { projectId, assetId: uploaded.assetId, path: '/narration/hook.mp3' }),
  /hook\.mp3/, 'move_asset must report the new path')
assert.match(await exec('list_assets', { projectId }), /hook\.mp3/, 'the tree must show the move')

// The refusal is the interesting half: point the document at the asset, and
// deleting it must be refused rather than leaving a scene pointing at nothing.
const { version } = (await (
  await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
).json()) as { version: number }
const referenced = await post(`/api/projects/${projectId}/ops`, {
  id: crypto.randomUUID(),
  baseVersion: version,
  actor: { type: 'agent', id: 'dev-user' },
  ops: [
    {
      kind: 'narration.set',
      sceneId,
      narration: {
        text: 'One two three.',
        audio: { assetId: uploaded.assetId, durationSec: 1.5, words: [] },
      },
    },
  ],
})
assert.equal(referenced.status, 200, `could not reference the asset: ${referenced.body}`)

const refused = await post('/api/agent/tools/remove_asset/execute', { projectId, assetId: uploaded.assetId })
assert.equal(refused.status, 409, 'a referenced asset must not be deletable')
assert.match(refused.body, /force: true/, 'the refusal must name the override')
assert.match(await exec('list_assets', { projectId }), /\[in use\]/, 'and the tree must mark it in use')

assert.match(
  await exec('remove_asset', { projectId, assetId: uploaded.assetId, force: true }),
  /was in use/,
  'force must delete and report what it broke',
)
console.log('assets OK — tree, move, in-use refusal, forced delete')

// record_answer reaches the Durable Object directly rather than through a
// route, so it needs its own pass — including the first-answer-wins rule.
const asked = JSON.parse(
  (
    await post(`/api/projects/${projectId}/decisions`, {
      question: 'Which pacing?',
      options: [
        { id: 'opt1', label: 'Tight' },
        { id: 'opt2', label: 'Roomy' },
      ],
    })
  ).body,
) as { decision: { id: string } }

const answered = await exec('record_answer', {
  projectId,
  decisionId: asked.decision.id,
  optionId: 'opt1',
})
assert.match(answered, /Tight/, 'record_answer must report the chosen option')

const twice = await post('/api/agent/tools/record_answer/execute', {
  projectId,
  decisionId: asked.decision.id,
  optionId: 'opt2',
})
assert.equal(twice.status, 409, 'a second answer must be refused, not silently overwrite')
assert.match(twice.body, /already answered/, 'the refusal must say why')
console.log('decisions OK — answer recorded through the gateway, first answer wins')

// Clean up the fixture, so a passing run leaves nothing behind. Deliberately
// only on success: a failed run keeps its project so the wreckage can be
// inspected in the editor. Debris from passing runs is what grew the project
// list to 105.
await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE', headers: H })

console.log(
  `gateway OK — ${listed.capabilities.length} capabilities behind 3 endpoints; ` +
    `instructions/describe/execute round trip, credit gate enforced, ` +
    `both update_node traps loud, captions still document-derived`,
)
