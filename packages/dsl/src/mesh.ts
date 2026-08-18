import type { Vec3 } from './document'
import { LIMITS } from './limits'

/**
 * Mesh geometry: surfaces described by a handful of numbers, expanded to
 * triangles on demand.
 *
 * The alternative — storing vertices and faces in the document — was rejected
 * twice over. A default sphere is 576 triangles, so every op would push ~100KB
 * through the event log, and an agent has no way to *type* a sphere. Naming the
 * shape instead keeps documents small and keeps the call writable, and costs
 * nothing in purity: expansion is a pure function of the node, so it composes
 * with the sampler exactly the way `plot_function` does.
 *
 * `custom` is the escape hatch, and it is what an imported mesh (a Fal 3D
 * generation, a GLB) will arrive as once there is something to import.
 */

export type Tri = [number, number, number]

export type MeshGeometry =
  | { kind: 'cube'; size: number }
  | { kind: 'sphere'; radius: number; segments: number }
  | { kind: 'torus'; radius: number; tube: number; segments: number }
  | { kind: 'cylinder'; radius: number; height: number; segments: number }
  | { kind: 'cone'; radius: number; height: number; segments: number }
  | { kind: 'plane'; width: number; depth: number; segments: number }
  | { kind: 'custom'; verts: Vec3[]; faces: Tri[] }

export const MESH_KINDS = [
  'cube',
  'sphere',
  'torus',
  'cylinder',
  'cone',
  'plane',
  'custom',
] as const

export interface MeshData {
  verts: Vec3[]
  faces: Tri[]
}

/**
 * Faces wind counter-clockwise when seen from outside, which is what lets the
 * renderer cull backfaces by screen-space winding alone. That cull is not a
 * performance tweak — the probe in plans/009 measured painter's-algorithm
 * ordering as *exactly* right on a self-occluding torus with culling on, and
 * merely close without it. Getting a winding backwards turns a solid inside
 * out, so every generator below is written to one convention.
 */

const TAU = Math.PI * 2

/** Segment counts are clamped rather than rejected: a mesh is a picture, not an assertion. */
function rings(segments: number): { nu: number; nv: number } {
  const nu = Math.max(3, Math.min(96, Math.round(segments)))
  return { nu, nv: Math.max(2, Math.round(nu / 2)) }
}

function cube(size: number): MeshData {
  const s = size / 2
  const verts: Vec3[] = []
  for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) verts.push({ x, y, z })
  // index = 4*(x>0) + 2*(y>0) + (z>0)
  const quad = (a: number, b: number, c: number, d: number): Tri[] => [
    [a, b, c],
    [a, c, d],
  ]
  const faces: Tri[] = [
    ...quad(0, 1, 3, 2), // -x
    ...quad(4, 6, 7, 5), // +x
    ...quad(0, 4, 5, 1), // -y
    ...quad(2, 3, 7, 6), // +y
    ...quad(0, 2, 6, 4), // -z
    ...quad(1, 5, 7, 3), // +z
  ]
  return { verts, faces }
}

function sphere(radius: number, segments: number): MeshData {
  const { nu, nv } = rings(segments)
  const verts: Vec3[] = []
  for (let i = 0; i <= nv; i++) {
    const phi = (i / nv) * Math.PI
    for (let j = 0; j <= nu; j++) {
      const th = (j / nu) * TAU
      verts.push({
        x: radius * Math.sin(phi) * Math.cos(th),
        // Negative so the pole sits *up* the screen, matching axes3d's y arrow.
        y: -radius * Math.cos(phi),
        z: radius * Math.sin(phi) * Math.sin(th),
      })
    }
  }
  const at = (i: number, j: number) => i * (nu + 1) + j
  const faces: Tri[] = []
  for (let i = 0; i < nv; i++) {
    for (let j = 0; j < nu; j++) {
      faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)])
      faces.push([at(i, j), at(i + 1, j + 1), at(i, j + 1)])
    }
  }
  return { verts, faces }
}

function torus(radius: number, tube: number, segments: number): MeshData {
  const { nu } = rings(segments)
  const nv = Math.max(3, Math.round(nu / 2))
  const verts: Vec3[] = []
  for (let i = 0; i < nu; i++) {
    const u = (i / nu) * TAU
    for (let j = 0; j < nv; j++) {
      const v = (j / nv) * TAU
      verts.push({
        x: (radius + tube * Math.cos(v)) * Math.cos(u),
        y: -tube * Math.sin(v),
        z: (radius + tube * Math.cos(v)) * Math.sin(u),
      })
    }
  }
  const at = (i: number, j: number) => (i % nu) * nv + (j % nv)
  const faces: Tri[] = []
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)])
      faces.push([at(i, j), at(i + 1, j + 1), at(i, j + 1)])
    }
  }
  return { verts, faces }
}

function cylinder(radius: number, height: number, segments: number): MeshData {
  const { nu } = rings(segments)
  const h = height / 2
  const verts: Vec3[] = []
  for (let j = 0; j < nu; j++) {
    const th = (j / nu) * TAU
    const x = radius * Math.cos(th)
    const z = radius * Math.sin(th)
    verts.push({ x, y: -h, z })
    verts.push({ x, y: h, z })
  }
  const top = verts.push({ x: 0, y: -h, z: 0 }) - 1
  const bottom = verts.push({ x: 0, y: h, z: 0 }) - 1
  const faces: Tri[] = []
  for (let j = 0; j < nu; j++) {
    const a = (j * 2) % (nu * 2)
    const b = a + 1
    const c = ((j + 1) % nu) * 2
    const d = c + 1
    // Wound outward, like every other generator here — see the winding
    // invariant in check-mesh.ts. This one was inverted on all 64 faces when
    // it landed, which culling turned into an open cup: it kept the far wall
    // and dropped the near one. The silhouette was identical, so only looking
    // at it caught it.
    faces.push([a, d, c], [a, b, d]) // side
    faces.push([top, a, c]) // cap
    faces.push([bottom, d, b])
  }
  return { verts, faces }
}

function cone(radius: number, height: number, segments: number): MeshData {
  const { nu } = rings(segments)
  const h = height / 2
  const verts: Vec3[] = []
  for (let j = 0; j < nu; j++) {
    const th = (j / nu) * TAU
    verts.push({ x: radius * Math.cos(th), y: h, z: radius * Math.sin(th) })
  }
  const apex = verts.push({ x: 0, y: -h, z: 0 }) - 1
  const base = verts.push({ x: 0, y: h, z: 0 }) - 1
  const faces: Tri[] = []
  for (let j = 0; j < nu; j++) {
    const a = j
    const b = (j + 1) % nu
    faces.push([apex, a, b])
    faces.push([base, b, a])
  }
  return { verts, faces }
}

function plane(width: number, depth: number, segments: number): MeshData {
  const { nu } = rings(segments)
  const verts: Vec3[] = []
  for (let i = 0; i <= nu; i++) {
    for (let j = 0; j <= nu; j++) {
      verts.push({
        x: (i / nu - 0.5) * width,
        y: 0,
        z: (j / nu - 0.5) * depth,
      })
    }
  }
  const at = (i: number, j: number) => i * (nu + 1) + j
  const faces: Tri[] = []
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nu; j++) {
      faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)])
      faces.push([at(i, j), at(i + 1, j + 1), at(i, j + 1)])
    }
  }
  return { verts, faces }
}

/**
 * Expand a geometry to vertices and faces. Pure and deterministic — the same
 * spec always yields the same triangles in the same order, which is what lets
 * the renderer cache on a key rather than rebuilding every frame.
 */
export function buildMesh(geom: MeshGeometry): MeshData {
  switch (geom.kind) {
    case 'cube':
      return cube(geom.size)
    case 'sphere':
      return sphere(geom.radius, geom.segments)
    case 'torus':
      return torus(geom.radius, geom.tube, geom.segments)
    case 'cylinder':
      return cylinder(geom.radius, geom.height, geom.segments)
    case 'cone':
      return cone(geom.radius, geom.height, geom.segments)
    case 'plane':
      return plane(geom.width, geom.depth, geom.segments)
    case 'custom':
      return { verts: geom.verts, faces: geom.faces }
  }
}

/**
 * Triangle count without building the mesh — so a tool can refuse an
 * expensive shape in its argument check rather than after allocating it.
 */
export function meshTriangleCount(geom: MeshGeometry): number {
  switch (geom.kind) {
    case 'cube':
      return 12
    case 'sphere': {
      const { nu, nv } = rings(geom.segments)
      return nu * nv * 2
    }
    case 'torus': {
      const { nu } = rings(geom.segments)
      return nu * Math.max(3, Math.round(nu / 2)) * 2
    }
    case 'cylinder':
      return rings(geom.segments).nu * 4
    case 'cone':
      return rings(geom.segments).nu * 2
    case 'plane': {
      const { nu } = rings(geom.segments)
      return nu * nu * 2
    }
    case 'custom':
      return geom.faces.length
  }
}

/** True when the geometry is within the per-node triangle ceiling. */
export function meshWithinLimits(geom: MeshGeometry): boolean {
  return meshTriangleCount(geom) <= LIMITS.maxTriangles
}

// ---------- operations on an imported mesh ----------

/**
 * Volume enclosed by a closed triangle mesh, signed by winding.
 *
 * The sign is the useful part: every generator above produces a **positive**
 * volume, so positive means "wound outward" in this system's convention. That
 * is what lets an imported mesh be oriented without reasoning about the source
 * file's handedness — and unlike an `n · centroid` test it works on a shape
 * that is not convex, which an imported model never is.
 */
export function signedVolume({ verts, faces }: MeshData): number {
  let v = 0
  for (const [a, b, c] of faces) {
    const p = verts[a]
    const q = verts[b]
    const r = verts[c]
    if (!p || !q || !r) continue
    v +=
      (p.x * (q.y * r.z - q.z * r.y) -
        p.y * (q.x * r.z - q.z * r.x) +
        p.z * (q.x * r.y - q.y * r.x)) /
      6
  }
  return v
}

/**
 * Wind every face outward, reversing the whole mesh if it is inside out.
 *
 * Runs **after** any reflection. Converting glTF's Y-up to this system's
 * Y-down negates an axis, which reverses orientation and would leave every
 * face pointing inward — culling then keeps the far surface and the model
 * renders as a hollow shell. That is exactly how the cylinder shipped
 * (plans/009, milestone run 7), so the importer measures rather than assumes.
 */
export function orientOutward(mesh: MeshData): MeshData {
  if (signedVolume(mesh) >= 0) return mesh
  return { verts: mesh.verts, faces: mesh.faces.map(([a, b, c]) => [a, c, b] as Tri) }
}

function bounds(verts: Vec3[]) {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  // A loop rather than Math.min(...verts) — spreading 165k arguments (a
  // hunyuan3d model) overflows the call stack.
  for (const v of verts) {
    if (v.x < minX) minX = v.x
    if (v.y < minY) minY = v.y
    if (v.z < minZ) minZ = v.z
    if (v.x > maxX) maxX = v.x
    if (v.y > maxY) maxY = v.y
    if (v.z > maxZ) maxZ = v.z
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

/** One clustering pass: snap vertices to an NxNxN grid and weld each cell. */
function cluster(mesh: MeshData, n: number): MeshData {
  const b = bounds(mesh.verts)
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) || 1
  const cell = extent / n

  const cells = new Map<number, { x: number; y: number; z: number; count: number; index: number }>()
  const remap = new Array<number>(mesh.verts.length)

  mesh.verts.forEach((v, i) => {
    const ix = Math.min(n, Math.floor((v.x - b.minX) / cell))
    const iy = Math.min(n, Math.floor((v.y - b.minY) / cell))
    const iz = Math.min(n, Math.floor((v.z - b.minZ) / cell))
    const key = ix + iy * (n + 2) + iz * (n + 2) * (n + 2)
    let entry = cells.get(key)
    if (!entry) {
      entry = { x: 0, y: 0, z: 0, count: 0, index: cells.size }
      cells.set(key, entry)
    }
    entry.x += v.x
    entry.y += v.y
    entry.z += v.z
    entry.count++
    remap[i] = entry.index
  })

  // The cell's average rather than its centre: a welded corner stays on the
  // surface instead of drifting to the middle of a grid box.
  const verts: Vec3[] = new Array(cells.size)
  for (const e of cells.values()) {
    verts[e.index] = { x: e.x / e.count, y: e.y / e.count, z: e.z / e.count }
  }

  const faces: Tri[] = []
  for (const [a, b2, c] of mesh.faces) {
    const ra = remap[a]!, rb = remap[b2]!, rc = remap[c]!
    // A triangle whose corners welded together is a sliver with no area.
    if (ra === rb || rb === rc || ra === rc) continue
    faces.push([ra, rb, rc])
  }
  return { verts, faces }
}

/**
 * Reduce a mesh to at most `targetFaces` triangles by vertex clustering.
 *
 * Clustering rather than quadric edge collapse: it is O(n), deterministic, and
 * cannot fail on the degenerate topology a generated model often has (loose
 * shells, duplicated vertices, non-manifold edges). It is cruder — it does not
 * preserve silhouettes as carefully — which matters far less at the size a
 * solid occupies in a frame than robustness does.
 *
 * The grid resolution is found by binary search rather than derived, because
 * the face count for a given resolution depends on the shape.
 */
export function decimateMesh(mesh: MeshData, targetFaces: number): MeshData {
  if (mesh.faces.length <= targetFaces) return mesh

  let lo = 4
  let hi = 256
  let best: MeshData | null = null
  // ~7 passes; each is linear, and it converges on the finest grid that still
  // fits the budget.
  for (let i = 0; i < 8 && lo <= hi; i++) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = cluster(mesh, mid)
    if (candidate.faces.length <= targetFaces) {
      best = candidate
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best ?? cluster(mesh, 4)
}

/**
 * Centre a mesh on its own origin, scale it so its longest axis is `size`
 * scene pixels, and convert glTF's Y-up to this system's Y-down.
 *
 * Coordinates are rounded to whole pixels. That is not cosmetic: the geometry
 * is stored in the document, the document lives under a single Durable Object
 * key, and DO values are capped at 128 KiB — so every character of coordinate
 * precision is budget that a scene cannot spend on anything else.
 */
export function normalizeMesh(mesh: MeshData, size: number): MeshData {
  const b = bounds(mesh.verts)
  const extent = Math.max(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) || 1
  const k = size / extent
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const cz = (b.minZ + b.maxZ) / 2
  const verts = mesh.verts.map((v) => ({
    x: Math.round((v.x - cx) * k),
    // glTF is Y-up; this system's y grows downward. Negating an axis reverses
    // orientation, which is why orientOutward has to run after this.
    y: Math.round(-(v.y - cy) * k),
    z: Math.round((v.z - cz) * k),
  }))
  return { verts, faces: mesh.faces }
}
