/**
 * Meshes (plans/009): solids that are actually solid, measured in pixels.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-mesh.ts
 *
 * Free — no credits. Needs `dev:api`, `dev:web`, and `render-worker.ts`.
 *
 * Intra-mesh face ordering was settled offline against a per-pixel z-buffer
 * (plans/009 records the numbers: exactly zero differing pixels on a torus).
 * What that probe could not test is the *integration* — that a mesh node
 * reaches the real Pixi surface, occludes what is behind it, shades per face,
 * and answers the camera. That is this script's job.
 *
 * The occlusion test uses the same trick check-3d does, because a correct
 * frame and a wrongly-ordered one contain the same shapes: a solid painted the
 * background colour is invisible against the backdrop but still covers what it
 * is drawn over. So a bright disc behind a background-coloured sphere must go
 * dark, and the identical pair with the sphere moved behind must not.
 */
import './load-env'
import assert from 'node:assert'
import { writeFileSync } from 'node:fs'
import { buildMesh, type MeshGeometry } from '@euclid/dsl'

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

// ---------- 0. every closed solid is wound outward ----------
//
// Pure, no rendering, and it runs first because it is the cheapest real check
// here — and because the pixel tests below cannot see this class of bug at all.
// A solid whose faces are wound inward has the *same silhouette* as a correct
// one, so its lit fraction is identical to four decimal places; culling simply
// keeps the far wall and drops the near one, and it renders as an open shell.
// That is exactly how the cylinder shipped, and only looking at a frame caught
// it.
//
// For a convex solid centred on the origin, an outward face satisfies
// n · centroid > 0. Degenerate triangles (the sphere's poles) are tangent and
// carry no winding, so they are counted and ignored rather than failed.
const CLOSED_CONVEX: MeshGeometry[] = [
  { kind: 'cube', size: 200 },
  { kind: 'sphere', radius: 200, segments: 16 },
  { kind: 'cylinder', radius: 200, height: 300, segments: 16 },
  { kind: 'cone', radius: 200, height: 300, segments: 16 },
]
for (const geom of CLOSED_CONVEX) {
  const { verts, faces } = buildMesh(geom)
  let inward = 0
  let oriented = 0
  for (const [ia, ib, ic] of faces) {
    const a = verts[ia]!, b = verts[ib]!, c = verts[ic]!
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z
    const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3, cz = (a.z + b.z + c.z) / 3
    const dot = nx * cx + ny * cy + nz * cz
    const scale = Math.hypot(nx, ny, nz) * Math.hypot(cx, cy, cz)
    if (scale < 1e-9 || Math.abs(dot) / scale < 1e-9) continue // degenerate/tangent
    oriented++
    if (dot < 0) inward++
  }
  assert.equal(
    inward,
    0,
    `${geom.kind}: ${inward} of ${oriented} faces are wound inward. Culling would keep the ` +
      `far surface and drop the near one, so it renders as an open shell with an identical ` +
      `silhouette — no pixel count below can see this.`,
  )
  assert.ok(oriented > 0, `${geom.kind}: no face carried an orientation at all`)
}

const projectId = (await ok('create_project', { name: 'Mesh Check' })).data.id
const scene = async (name: string, duration = 4) =>
  (await ok('add_scene', { projectId, name, duration, background: BG })).data.sceneId as string
const nodesOf = async (sceneId: string) =>
  (await ok('get_scene', { projectId, sceneId })).data.scene.nodes as { id: string }[]

// ---------- 1. a solid is solid: it hides what is behind it ----------
// A bright disc, and a sphere painted the backdrop colour in front of it. The
// sphere is invisible in itself, so the only thing the lit fraction can be
// measuring is whether the mesh covered the disc.
const hideScene = await scene('Sphere in front')
await ok('add_shape', {
  projectId, sceneId: hideScene, shape: 'circle', x: 960, y: 540, radius: 240, fill: '#ffffff',
})
await ok('update_node', {
  projectId, sceneId: hideScene,
  nodeId: (await nodesOf(hideScene))[0]!.id,
  patch: { z: -400 },
})
await ok('add_mesh', {
  projectId, sceneId: hideScene, shape: 'sphere', x: 960, y: 540, z: 400,
  size: 300, segments: 32, fill: BG, shading: 'none',
})

// The identical pair with only the depths swapped — the sphere behind the disc
// now, so the disc must survive.
const showScene = await scene('Sphere behind')
await ok('add_shape', {
  projectId, sceneId: showScene, shape: 'circle', x: 960, y: 540, radius: 240, fill: '#ffffff',
})
await ok('update_node', {
  projectId, sceneId: showScene,
  nodeId: (await nodesOf(showScene))[0]!.id,
  patch: { z: 400 },
})
await ok('add_mesh', {
  projectId, sceneId: showScene, shape: 'sphere', x: 960, y: 540, z: -400,
  size: 300, segments: 32, fill: BG, shading: 'none',
})

const [hidden, shown] = await inkAt(projectId, [2, 6], 'check-mesh-occlusion.png')
assert.ok(shown! > 0.02, `the disc must be visible when nothing covers it (${pct(shown!)})`)
assert.ok(
  hidden! < shown! * 0.15,
  `a solid in front must hide the disc behind it: ${pct(shown!)} → ${pct(hidden!)}. ` +
    `Equal readings would mean the mesh is drawing as an outline, or not at all.`,
)

// ---------- 2. shading is per face, not per node ----------
// Same sphere twice, mid-grey, with almost no ambient. Flat shading drives the
// faces turned away from the light below the luma threshold, so it must read
// as *less* lit than the same sphere filled uniformly. A single-colour mesh
// would score identically both ways.
const flatScene = await scene('Flat shaded')
await ok('add_mesh', {
  projectId, sceneId: flatScene, shape: 'sphere', x: 960, y: 540,
  size: 340, segments: 32, fill: '#9aa6b2', shading: 'flat', ambient: 0.02,
})
const noneScene = await scene('Unshaded')
await ok('add_mesh', {
  projectId, sceneId: noneScene, shape: 'sphere', x: 960, y: 540,
  size: 340, segments: 32, fill: '#9aa6b2', shading: 'none',
})
const [flatInk, noneInk] = await inkAt(projectId, [10, 14], 'check-mesh-shading.png')
assert.ok(noneInk! > 0.02, `an unshaded sphere must fill its silhouette (${pct(noneInk!)})`)
assert.ok(
  flatInk! < noneInk! * 0.92,
  `flat shading must darken the faces turned away from the light: ` +
    `${pct(noneInk!)} unshaded vs ${pct(flatInk!)} shaded. Equal readings mean every ` +
    `face got the same colour, which is not shading.`,
)

// ---------- 3. culling does not change a closed solid ----------
// The visible consequence of the sort being right: with ordering correct, the
// back faces are painted first and then covered, so dropping them changes
// nothing on screen. A wrong sort would let them show through.
const cullScene = await scene('Culled')
await ok('add_mesh', {
  projectId, sceneId: cullScene, shape: 'sphere', x: 960, y: 540,
  size: 340, segments: 24, fill: '#58c4dd', cull: true,
})
await ok('set_camera', { projectId, sceneId: cullScene, yaw: 0.7, pitch: 0.4 })
const noCullScene = await scene('Not culled')
await ok('add_mesh', {
  projectId, sceneId: noCullScene, shape: 'sphere', x: 960, y: 540,
  size: 340, segments: 24, fill: '#58c4dd', cull: false,
})
await ok('set_camera', { projectId, sceneId: noCullScene, yaw: 0.7, pitch: 0.4 })
const [culled, uncalled] = await inkAt(projectId, [18, 22])
const cullDelta = Math.abs(culled! - uncalled!) / Math.max(culled!, uncalled!)
assert.ok(
  cullDelta < 0.05,
  `a closed solid must look the same culled or not — the back faces are covered either ` +
    `way if the sort is right: ${pct(culled!)} vs ${pct(uncalled!)} (${pct(cullDelta)} apart)`,
)

// ---------- 4. the solid is where it says it is ----------
// Ink cannot see *where*, so frame the camera hard on one spot: the centre of a
// cube's face must be lit, and a point well outside the cube must not be. This
// is check-axes' argument applied to geometry.
const placeScene = await scene('Placement', 8)
await ok('add_mesh', {
  projectId, sceneId: placeScene, shape: 'cube', x: 960, y: 540, size: 300, fill: '#ffffff',
})
await ok('set_camera', { projectId, sceneId: placeScene, zoom: 8, x: 960, y: 540 })
const onCube = (await inkAt(projectId, [26]))[0]!
await ok('set_camera', { projectId, sceneId: placeScene, zoom: 8, x: 1600, y: 540 })
const offCube = (await inkAt(projectId, [26]))[0]!
assert.ok(
  onCube > 0.5,
  `framed on the middle of a 300px cube at 8x, the frame should be almost all cube (${pct(onCube)})`,
)
assert.ok(
  offCube < 0.02,
  `and framed 640px to the side, empty: ${pct(onCube)} on it vs ${pct(offCube)} beside it`,
)

// ---------- 5. turning the camera changes the picture ----------
// A torus goes from a bar seen edge-on to a ring with a hole seen from above,
// so its lit fraction has to move. Note this is a **pitch**, not a yaw: the
// ring lies in the xz plane, which makes it rotationally symmetric about the
// vertical axis — a yaw orbit leaves its silhouette identical, correctly, and
// would prove nothing about whether the solid is being projected at all.
const orbitScene = await scene('Orbit', 10)
await ok('add_mesh', {
  projectId, sceneId: orbitScene, shape: 'torus', x: 960, y: 540,
  size: 340, tube: 110, segments: 40, fill: '#e8c74a',
})
await ok('set_camera', { projectId, sceneId: orbitScene, pitch: 0.02, yaw: 0.3 })
await ok('move_camera', {
  projectId, sceneId: orbitScene, pitch: 1.35, start: 0.5, duration: 8,
})
const orbit = await inkAt(projectId, [34.5, 37, 39.5, 41.5], 'check-mesh-orbit.png')
assert.ok(orbit.every((v) => v > 0.01), `the torus must be drawn at every angle: ${orbit.map(pct).join(' ')}`)
const spread = Math.max(...orbit) - Math.min(...orbit)
assert.ok(
  spread > 0.01,
  `a torus turned through 90° must change shape on screen; it barely moved: ${orbit.map(pct).join(' ')}`,
)

// ---------- 6. a solid builds up face by face ----------
const writeScene = await scene('Write on', 6)
const writeId = (
  await ok('add_mesh', {
    projectId, sceneId: writeScene, shape: 'sphere', x: 960, y: 540,
    size: 340, segments: 28, fill: '#ffffff',
  })
).data.nodeId
await ok('set_camera', { projectId, sceneId: writeScene, yaw: 0.5, pitch: 0.3 })
await ok('write_on', { projectId, sceneId: writeScene, nodeId: writeId, start: 0, duration: 4 })
// Sampled inside the 4s reveal — local 1.0s, 2.0s, 3.5s. Past its end every
// tile is the finished solid, which reads as a plateau rather than a build.
const build = await inkAt(projectId, [43, 44, 45.5], 'check-mesh-write.png')
assert.ok(
  build[0]! < build[1]! && build[1]! < build[2]!,
  `a solid must arrive face by face: ${build.map(pct).join(' → ')}`,
)

// ---------- 7. the errors teach ----------
const tooMany = await run('add_mesh', {
  projectId, sceneId: placeScene, shape: 'sphere', x: 960, y: 540, size: 200, segments: 96,
})
assert.equal(tooMany.status, 400)
assert.match(tooMany.body, /triangles/, 'over the ceiling, the error counts the triangles')
assert.match(tooMany.body, /frame-time/, 'and says why there is a ceiling at all')

const badSegments = await run('add_mesh', {
  projectId, sceneId: placeScene, shape: 'sphere', x: 960, y: 540, size: 200, segments: 2,
})
assert.equal(badSegments.status, 400, 'a degenerate segment count is refused rather than clamped')

// The outline names the solid, so an agent reading a scene knows what it holds.
const outline = await ok('get_scene', { projectId, sceneId: orbitScene })
assert.match(
  JSON.stringify(outline.data),
  /torus/,
  'the scene outline should say which solid a mesh node is',
)

await ok('delete_project', { projectId, confirm: true })

console.log(
  `mesh OK — occlusion ${pct(shown!)} → ${pct(hidden!)} with a solid in front, ` +
    `shading ${pct(noneInk!)} flat-lit vs ${pct(flatInk!)} shaded, ` +
    `cull/no-cull agree to ${pct(cullDelta)}, placement ${pct(onCube)} on vs ${pct(offCube)} beside, ` +
    `orbit ${orbit.map(pct).join(' ')}, build-up ${build.map(pct).join('→')}. ` +
    `Triangle ceiling and segment errors both teach. Frames in ${OUT}/check-mesh-*.png`,
)
