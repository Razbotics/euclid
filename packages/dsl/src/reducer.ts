import { EuclidDocSchema, NodeSchema, type EuclidDoc, type EuclidNode } from './document'
import { collectNodeIds, findNode } from './helpers'
import type { Op, OpEnvelope } from './ops'

export class OpError extends Error {
  constructor(
    public code:
      | 'scene_not_found'
      | 'node_not_found'
      | 'parent_not_group'
      | 'duplicate_id'
      | 'invalid_patch'
      | 'invalid_result',
    message: string,
  ) {
    super(message)
    this.name = 'OpError'
  }
}

/**
 * Pure reducer shared by every writer:
 *  - the ProjectDO applies envelopes here before persisting + broadcasting
 *  - the web editor applies the same envelopes optimistically
 * Throws OpError (envelope is atomic — all ops or none); never mutates input.
 */
export function applyEnvelope(doc: EuclidDoc, envelope: OpEnvelope): EuclidDoc {
  return applyOps(doc, envelope.ops)
}

export function applyOps(doc: EuclidDoc, ops: Op[]): EuclidDoc {
  const next = structuredClone(doc)
  for (const op of ops) applyOp(next, op)
  const parsed = EuclidDocSchema.safeParse(next)
  if (!parsed.success) {
    throw new OpError('invalid_result', `ops produced an invalid document: ${parsed.error.message}`)
  }
  return parsed.data
}

function requireScene(doc: EuclidDoc, sceneId: string) {
  const scene = doc.scenes.find((s) => s.id === sceneId)
  if (!scene) throw new OpError('scene_not_found', `scene ${sceneId} not found`)
  return scene
}

const IMMUTABLE_NODE_KEYS = new Set(['id', 'type', 'children'])

function applyOp(doc: EuclidDoc, op: Op): void {
  switch (op.kind) {
    case 'project.rename':
      doc.name = op.name
      return
    case 'project.setCanvas':
      doc.canvas = op.canvas
      return

    case 'scene.add': {
      if (doc.scenes.some((s) => s.id === op.scene.id)) {
        throw new OpError('duplicate_id', `scene ${op.scene.id} already exists`)
      }
      const i = op.index ?? doc.scenes.length
      doc.scenes.splice(Math.min(i, doc.scenes.length), 0, op.scene)
      return
    }
    case 'scene.remove': {
      const i = doc.scenes.findIndex((s) => s.id === op.sceneId)
      if (i < 0) throw new OpError('scene_not_found', `scene ${op.sceneId} not found`)
      doc.scenes.splice(i, 1)
      return
    }
    case 'scene.update': {
      const scene = requireScene(doc, op.sceneId)
      Object.assign(scene, op.patch)
      return
    }
    case 'scene.move': {
      const i = doc.scenes.findIndex((s) => s.id === op.sceneId)
      if (i < 0) throw new OpError('scene_not_found', `scene ${op.sceneId} not found`)
      const [scene] = doc.scenes.splice(i, 1)
      doc.scenes.splice(Math.min(op.index, doc.scenes.length), 0, scene!)
      return
    }

    case 'node.add': {
      const scene = requireScene(doc, op.sceneId)
      const existing = new Set(collectNodeIds(scene.nodes))
      for (const id of collectNodeIds([op.node])) {
        if (existing.has(id)) throw new OpError('duplicate_id', `node ${id} already exists in scene`)
      }
      let target = scene.nodes
      if (op.parentId) {
        const parent = findNode(scene.nodes, op.parentId)
        if (!parent) throw new OpError('node_not_found', `parent ${op.parentId} not found`)
        if (parent.node.type !== 'group') {
          throw new OpError('parent_not_group', `parent ${op.parentId} is a ${parent.node.type}, not a group`)
        }
        target = parent.node.children
      }
      const i = op.index ?? target.length
      target.splice(Math.min(i, target.length), 0, op.node)
      return
    }
    case 'node.remove': {
      const scene = requireScene(doc, op.sceneId)
      const hit = findNode(scene.nodes, op.nodeId)
      if (!hit) throw new OpError('node_not_found', `node ${op.nodeId} not found`)
      hit.siblings.splice(hit.index, 1)
      return
    }
    case 'node.update': {
      const scene = requireScene(doc, op.sceneId)
      const hit = findNode(scene.nodes, op.nodeId)
      if (!hit) throw new OpError('node_not_found', `node ${op.nodeId} not found`)
      const merged: Record<string, unknown> = { ...hit.node }
      const assigned: string[] = []
      for (const [k, v] of Object.entries(op.patch)) {
        if (IMMUTABLE_NODE_KEYS.has(k)) continue
        if (v === null) delete merged[k]
        else {
          merged[k] = v
          assigned.push(k)
        }
      }
      const parsed = NodeSchema.safeParse(merged)
      if (!parsed.success) {
        throw new OpError('invalid_patch', `patch on ${op.nodeId}: ${parsed.error.message}`)
      }
      // Zod strips keys the schema doesn't know, so a patch of `{x, y}` — the
      // top-level form add_text/add_latex accept — used to parse cleanly,
      // change nothing, and report success. Comparing what we assigned against
      // what survived catches that without hardcoding a key list per node type.
      const result = parsed.data as unknown as Record<string, unknown>
      const unknown = assigned.filter((k) => !(k in result))
      if (unknown.length > 0) {
        throw new OpError(
          'invalid_patch',
          `${hit.node.type} node ${op.nodeId} has no propert${unknown.length > 1 ? 'ies' : 'y'} ` +
            `${unknown.join(', ')} — nothing would have changed. ` +
            `Position is {"position":{"x":…,"y":…}}, not top-level x/y.`,
        )
      }
      hit.siblings[hit.index] = parsed.data as EuclidNode
      return
    }

    case 'track.set': {
      const scene = requireScene(doc, op.sceneId)
      const hit = findNode(scene.nodes, op.nodeId)
      if (!hit) throw new OpError('node_not_found', `node ${op.nodeId} not found`)
      const track = {
        ...op.track,
        keyframes: [...op.track.keyframes].sort((a, b) => a.t - b.t),
      }
      hit.node.tracks = [...hit.node.tracks.filter((t) => t.property !== track.property), track]
      return
    }
    case 'track.remove': {
      const scene = requireScene(doc, op.sceneId)
      const hit = findNode(scene.nodes, op.nodeId)
      if (!hit) throw new OpError('node_not_found', `node ${op.nodeId} not found`)
      hit.node.tracks = hit.node.tracks.filter((t) => t.property !== op.property)
      return
    }

    case 'narration.set': {
      requireScene(doc, op.sceneId).narration = op.narration
      return
    }
    case 'narration.clear': {
      delete requireScene(doc, op.sceneId).narration
      return
    }
  }
}
