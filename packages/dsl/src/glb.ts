import type { Vec3 } from './document'
import type { MeshData, Tri } from './mesh'

/**
 * Reading a generated 3D model — glTF 2.0, binary (.glb).
 *
 * Written against `ArrayBuffer`/`DataView` only, no Node types and no
 * dependencies, so it runs in the API worker where an imported asset is turned
 * into a mesh node.
 *
 * Deliberately partial. It reads **geometry and nothing else**: positions and
 * indices, with node transforms applied. Materials, textures, normals, UVs,
 * skins and animation are skipped, because the renderer flat-shades from face
 * winding and has nowhere to put the rest. Draco-compressed files are refused
 * by name rather than silently producing an empty mesh — neither model in the
 * fal roster uses it (measured, plans/009), so a decompressor would be dead
 * weight until one does.
 */

const MAGIC_GLTF = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942

/** Bytes per component, by glTF componentType. */
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, // byte
  5121: 1, // unsigned byte
  5122: 2, // short
  5123: 2, // unsigned short
  5125: 4, // unsigned int
  5126: 4, // float
}
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

export class GlbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GlbError'
  }
}

interface Gltf {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: {
    mesh?: number
    children?: number[]
    matrix?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
  }[]
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[]
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  extensionsRequired?: string[]
}

/** Column-major 4x4, the order glTF stores `matrix` in. */
type Mat4 = number[]

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!
      out[c * 4 + r] = sum
    }
  }
  return out
}

/** TRS → matrix, with rotation as a glTF quaternion (x, y, z, w). */
function fromTrs(t?: number[], r?: number[], s?: number[]): Mat4 {
  const [x, y, z, w] = r ?? [0, 0, 0, 1]
  const [sx, sy, sz] = s ?? [1, 1, 1]
  const [tx, ty, tz] = t ?? [0, 0, 0]
  const x2 = x! + x!, y2 = y! + y!, z2 = z! + z!
  const xx = x! * x2, xy = x! * y2, xz = x! * z2
  const yy = y! * y2, yz = y! * z2, zz = z! * z2
  const wx = w! * x2, wy = w! * y2, wz = w! * z2
  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ]
}

function transform(m: Mat4, v: Vec3): Vec3 {
  return {
    x: m[0]! * v.x + m[4]! * v.y + m[8]! * v.z + m[12]!,
    y: m[1]! * v.x + m[5]! * v.y + m[9]! * v.z + m[13]!,
    z: m[2]! * v.x + m[6]! * v.y + m[10]! * v.z + m[14]!,
  }
}

/** Split the GLB container into its JSON and BIN chunks. */
function chunks(buf: ArrayBuffer): { json: Gltf; bin: ArrayBuffer | null } {
  if (buf.byteLength < 12) throw new GlbError('not a GLB: shorter than its own header')
  const view = new DataView(buf)
  if (view.getUint32(0, true) !== MAGIC_GLTF) {
    throw new GlbError('not a GLB: the file does not begin with the glTF magic number')
  }
  const version = view.getUint32(4, true)
  if (version !== 2) throw new GlbError(`glTF version ${version} is not supported (this reads glTF 2.0)`)

  let json: Gltf | null = null
  let bin: ArrayBuffer | null = null
  let off = 12
  while (off + 8 <= buf.byteLength) {
    const length = view.getUint32(off, true)
    const type = view.getUint32(off + 4, true)
    const start = off + 8
    if (start + length > buf.byteLength) break // truncated; take what parsed
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, length))) as Gltf
    } else if (type === CHUNK_BIN) {
      bin = buf.slice(start, start + length)
    }
    off = start + length
  }
  if (!json) throw new GlbError('GLB has no JSON chunk')
  return { json, bin }
}

/** Read one accessor as a flat number array. */
function readAccessor(json: Gltf, bin: ArrayBuffer, index: number): number[] {
  const acc = json.accessors?.[index]
  if (!acc) throw new GlbError(`accessor ${index} is missing`)
  const comps = TYPE_COUNT[acc.type]
  const size = COMPONENT_BYTES[acc.componentType]
  if (!comps || !size) {
    throw new GlbError(`accessor ${index} has an unsupported type ${acc.type}/${acc.componentType}`)
  }
  if (acc.bufferView === undefined) return new Array<number>(acc.count * comps).fill(0)

  const bv = json.bufferViews?.[acc.bufferView]
  if (!bv) throw new GlbError(`bufferView ${acc.bufferView} is missing`)
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  // A byteStride means the attribute is interleaved with others; without one
  // the elements are tightly packed.
  const stride = bv.byteStride ?? comps * size
  const view = new DataView(bin)
  const out: number[] = []

  for (let i = 0; i < acc.count; i++) {
    const at = base + i * stride
    for (let c = 0; c < comps; c++) {
      const p = at + c * size
      if (p + size > bin.byteLength) throw new GlbError('accessor reads past the end of the buffer')
      switch (acc.componentType) {
        case 5120: out.push(view.getInt8(p)); break
        case 5121: out.push(view.getUint8(p)); break
        case 5122: out.push(view.getInt16(p, true)); break
        case 5123: out.push(view.getUint16(p, true)); break
        case 5125: out.push(view.getUint32(p, true)); break
        default: out.push(view.getFloat32(p, true))
      }
    }
  }
  return out
}

/**
 * Geometry from a GLB, in glTF's own coordinates (Y up, right-handed).
 *
 * Every primitive in the scene is merged into one vertex/face list with its
 * node transform baked in — the renderer draws one node per mesh, and a
 * generated model is a single object regardless of how its exporter split it.
 */
export function parseGlb(buf: ArrayBuffer): MeshData {
  const { json, bin } = chunks(buf)
  const required = json.extensionsRequired ?? []
  const draco = required.find((e) => e.includes('draco'))
  if (draco) {
    throw new GlbError(
      `this file requires ${draco}; compressed geometry is not supported. Re-export without Draco.`,
    )
  }
  if (!bin) throw new GlbError('GLB has no binary chunk, so it carries no geometry')

  const verts: Vec3[] = []
  const faces: Tri[] = []

  const visit = (nodeIndex: number, parent: Mat4): void => {
    const node = json.nodes?.[nodeIndex]
    if (!node) return
    const local = node.matrix
      ? (node.matrix as Mat4)
      : fromTrs(node.translation, node.rotation, node.scale)
    const world = multiply(parent, local)

    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh]
      for (const prim of mesh?.primitives ?? []) {
        // mode 4 is TRIANGLES; strips and fans are rare in exports and are
        // skipped rather than mis-read as triangles.
        if ((prim.mode ?? 4) !== 4) continue
        const posIndex = prim.attributes.POSITION
        if (posIndex === undefined) continue
        const pos = readAccessor(json, bin, posIndex)
        const offset = verts.length
        for (let i = 0; i + 2 < pos.length; i += 3) {
          verts.push(transform(world, { x: pos[i]!, y: pos[i + 1]!, z: pos[i + 2]! }))
        }
        const count = pos.length / 3
        if (prim.indices === undefined) {
          for (let i = 0; i + 2 < count; i += 3) {
            faces.push([offset + i, offset + i + 1, offset + i + 2])
          }
        } else {
          const idx = readAccessor(json, bin, prim.indices)
          for (let i = 0; i + 2 < idx.length; i += 3) {
            faces.push([offset + idx[i]!, offset + idx[i + 1]!, offset + idx[i + 2]!])
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }

  const scene = json.scenes?.[json.scene ?? 0]
  const roots = scene?.nodes ?? json.nodes?.map((_, i) => i) ?? []
  for (const r of roots) visit(r, IDENTITY)

  if (faces.length === 0) throw new GlbError('no triangles found in the file')
  return { verts, faces }
}
