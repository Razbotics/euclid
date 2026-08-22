/**
 * Draw order and resolved state, measured in pixels (plans/011 gaps 1 and 2).
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-order.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * Two claims that a document read cannot settle:
 *
 *  1. `reorder_node` changes what covers what. get_scene can only show that an
 *     array changed order; whether that reaches the frame is a question for the
 *     renderer, and this is the one capability whose entire purpose is a
 *     property of the picture.
 *
 *  2. `sample_at` reports where a node **actually is**. It answers from the
 *     sampler; the renderer draws from the same sampler, so the two must agree
 *     — and the only way to know they do is to point the camera at the
 *     coordinate it reported and find ink there. A resolver that silently
 *     disagreed with the stage would be worse than no resolver at all, because
 *     it would be trusted.
 */
import './load-env'
import assert from 'node:assert'

const API = process.env.API_URL ?? 'http://localhost:8787'
const PREVIEW = process.env.PREVIEW_ORIGIN ?? 'http://localhost:8790'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }

const health = await fetch(`${PREVIEW}/health`).catch(() => null)
if (!health?.ok) {
  console.error(
    `preview backend not running at ${PREVIEW}\n` +
      '  pnpm --filter @euclid/renderer exec tsx src/render-worker.ts',
  )
  process.exit(1)
}

async function ok(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(args),
  })
  const body = await res.text()
  assert.equal(res.status, 200, `${name} failed: ${body}`)
  return JSON.parse(body)
}

/**
 * Lit fraction of one frame, from the same capture path `preview_frames` uses.
 *
 * Measured in the browser over the tile's own pixels — a PNG cannot be asked
 * cheaply, since row filtering flattens empty regions to almost nothing and
 * makes a byte-length guard rate a blank frame as busy.
 */
async function ink(projectId: string, t: number): Promise<number> {
  const { doc } = (await (
    await fetch(`${API}/api/projects/${projectId}/doc`, { headers: H })
  ).json()) as { doc: unknown }
  const res = await fetch(`${PREVIEW}/preview`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ doc, tiles: [{ t, label: 'measure' }], columns: 1 }),
  })
  if (!res.ok) assert.fail(`capture failed: ${await res.text()}`)
  // Drained rather than inspected: the picture is not the assertion here, the
  // ink header is. (Reading it as text first would consume the body.)
  await res.arrayBuffer()
  const [lit] = JSON.parse(res.headers.get('x-preview-ink') ?? '[]') as number[]
  assert.ok(lit !== undefined, 'the preview backend must report ink')
  return lit
}

const pct = (v: number) => `${(v * 100).toFixed(2)}%`

// ---------- 1. reordering changes what covers what ----------
// A bright disc, then a lid painted over it. Both are opaque, so the only thing
// deciding which one you see is document order.
const projectId = (await ok('create_project', { name: 'Order Check' })).data.id
const sceneId = (await ok('add_scene', { projectId, name: 'Cover', duration: 4 })).data.sceneId
await ok('update_scene', { projectId, sceneId, background: '#000000' })

const disc = (
  await ok('add_shape', {
    projectId, sceneId, shape: 'circle', x: 960, y: 540, radius: 400, fill: '#ffffff',
  })
).data.nodeId

const bare = await ink(projectId, 0)
assert.ok(bare > 0.15, `a 400px white disc should light the frame, got ${pct(bare)}`)

// A near-black lid over the whole canvas: below the luma threshold, so it reads
// as unlit — which is the point. If it draws on top, the disc disappears.
const lid = (
  await ok('add_shape', {
    projectId, sceneId, shape: 'rect', x: 960, y: 540,
    width: 1920, height: 1080, fill: '#050505', strokeWidth: 0,
  })
).data.nodeId

const covered = await ink(projectId, 0)
assert.ok(covered < 0.001, `the lid must hide the disc, got ${pct(covered)}`)

// The whole gap: before this, the only way to get the disc back was to delete
// both nodes and re-add them in the other order.
await ok('reorder_node', { projectId, sceneId, nodeId: lid, to: 'back' })
const uncovered = await ink(projectId, 0)
assert.ok(
  Math.abs(uncovered - bare) < 0.005,
  `sending the lid to the back must restore the disc: ${pct(bare)} → ${pct(covered)} → ${pct(uncovered)}`,
)

// ...and the inverse, so this is an ordering and not a one-way "send to back".
await ok('reorder_node', { projectId, sceneId, nodeId: disc, before: lid })
const recovered = await ink(projectId, 0)
assert.ok(recovered < 0.001, `putting the disc behind the lid must hide it again, got ${pct(recovered)}`)
console.log(
  `draw order OK — disc ${pct(bare)} → covered ${pct(covered)} → reordered ${pct(uncovered)} ` +
    `→ behind again ${pct(recovered)}`,
)

// ---------- 2. sample_at agrees with the renderer ----------
// The position under test is one no caller could read off the document: a dot
// at (200, 0) inside a group at (400, 300) that has turned a quarter circle.
// The document says (200, 0); the sampler says (400, 500); the renderer draws
// it somewhere. Framing the camera decides which of those is true, because ink
// alone cannot see *where*.
const s2 = (await ok('add_scene', { projectId, name: 'Where', duration: 8 })).data.sceneId
await ok('update_scene', { projectId, sceneId: s2, background: '#000000' })
const pivot = (await ok('add_group', { projectId, sceneId: s2, x: 400, y: 300 })).data.nodeId
await ok('add_shape', {
  projectId, sceneId: s2, shape: 'circle', x: 200, y: 0, radius: 40, fill: '#ffffff',
  parentId: pivot,
})
await ok('animate', {
  projectId, sceneId: s2, nodeId: pivot,
  property: 'rotation', to: Math.PI / 2, start: 0, duration: 4, easing: 'linear',
})

const claimed = (await ok('sample_at', { projectId, sceneId: s2, t: 4 })).data.nodes.find(
  (n: { type: string }) => n.type === 'circle',
) as { world: { x: number; y: number } }
assert.ok(
  Math.abs(claimed.world.x - 400) < 0.01 && Math.abs(claimed.world.y - 500) < 0.01,
  `sample_at should resolve the rotated child to (400, 500), got ${JSON.stringify(claimed.world)}`,
)

// Scene 2 starts at 4s on the global timeline, so the moment under test is 8s.
const AT = 4 + 4
// Tight enough that being wrong by the dot's own diameter reads as empty.
const ZOOM = 6
await ok('set_camera', {
  projectId, sceneId: s2, x: claimed.world.x, y: claimed.world.y, zoom: ZOOM,
})
const onIt = await ink(projectId, AT)

// Two dot-diameters away, at the same zoom. If ink were merely "something is
// lit somewhere", this would score the same.
await ok('set_camera', {
  projectId, sceneId: s2, x: claimed.world.x + 160, y: claimed.world.y + 160, zoom: ZOOM,
})
const beside = await ink(projectId, AT)

// And where the raw document says the dot is, which is the answer a caller
// gets by reading get_scene and not composing the group transform.
await ok('set_camera', { projectId, sceneId: s2, x: 200, y: 0, zoom: ZOOM })
const naive = await ink(projectId, AT)

// Centred on the reported point at 6x, a 40px dot covers π(40·6)² of a
// 1920x1080 frame — 8.73%. Asserting the computed area rather than "some ink"
// is what makes this a position check: a dot half out of frame still lights
// the picture, and would pass a `> 0` test while sitting somewhere else.
const EXPECTED = (Math.PI * (40 * ZOOM) ** 2) / (1920 * 1080)
assert.ok(
  Math.abs(onIt - EXPECTED) < 0.005,
  `the dot must be centred where sample_at said it is (${claimed.world.x}, ${claimed.world.y}): ` +
    `expected ${pct(EXPECTED)} of the frame, got ${pct(onIt)}`,
)
assert.ok(beside < 0.01, `and not 160px away, got ${pct(beside)}`)
assert.ok(naive < 0.01, `and not at the document's un-composed (200, 0), got ${pct(naive)}`)
console.log(
  `sample_at OK — camera on its answer reads ${pct(onIt)} against a computed ${pct(EXPECTED)}; ` +
    `160px off ${pct(beside)}, at the raw document position ${pct(naive)}`,
)

// The other half of the claim: when sample_at says a node is not drawn, it is
// not drawn. Off-frame is the case a caller is most likely to mis-diagnose as a
// missing node.
const offText = (await ok('sample_at', { projectId, sceneId: s2, t: 4 })).text as string
assert.match(offText, /OFF-FRAME/, 'the dot is outside this framing and must be reported so')
const off = await ink(projectId, AT)
assert.ok(off < 0.01, `a node reported OFF-FRAME must really be absent, got ${pct(off)}`)

await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE', headers: H })
console.log('order OK — reordering reaches the frame, and sample_at agrees with the renderer')
