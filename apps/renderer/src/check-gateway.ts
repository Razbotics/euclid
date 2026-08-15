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
assert.deepStrictEqual(
  paid,
  ['generate_narration', 'render_video'],
  'exactly the two credit-spending capabilities must be flagged paid',
)
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
