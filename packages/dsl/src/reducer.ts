import { EuclidDocSchema, NodeSchema, type EuclidDoc, type EuclidNode } from './document'
import { collectNodeIds, findNode } from './helpers'
import type { Op, OpEnvelope } from './ops'

export class OpError extends Error {
  constructor(
    public code:
      | 'scene_not_found'
      | 'node_not_found'
      | 'parent_not_group'
      | 'invalid_move'
      | 'duplicate_id'
      | 'invalid_patch'
      | 'invalid_result'
      | 'track_not_found'
      | 'clip_not_found',
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

/**
 * Audio lives on the document, so an op naming a lane that is gone must say so
 * rather than silently no-op — the editor sends these from a drag that started
 * before someone else removed the track.
 */
function requireAudioTrack(doc: EuclidDoc, trackId: string) {
  const track = doc.audio?.find((t) => t.id === trackId)
  if (!track) throw new OpError('track_not_found', `audio track ${trackId} not found`)
  return track
}

function requireAudioClip(doc: EuclidDoc, trackId: string, clipId: string) {
  const track = requireAudioTrack(doc, trackId)
  const clip = track.clips.find((c) => c.id === clipId)
  if (!clip) throw new OpError('clip_not_found', `clip ${clipId} not found on track ${trackId}`)
  return { track, clip }
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
    case 'node.move': {
      const scene = requireScene(doc, op.sceneId)
      const hit = findNode(scene.nodes, op.nodeId)
      if (!hit) throw new OpError('node_not_found', `node ${op.nodeId} not found`)
      let target = scene.nodes
      if (op.parentId) {
        if (op.parentId === op.nodeId) {
          throw new OpError('invalid_move', `${op.nodeId} cannot be moved into itself`)
        }
        const parent = findNode(scene.nodes, op.parentId)
        if (!parent) throw new OpError('node_not_found', `parent ${op.parentId} not found`)
        if (parent.node.type !== 'group') {
          throw new OpError('parent_not_group', `parent ${op.parentId} is a ${parent.node.type}, not a group`)
        }
        // A group moved inside its own descendant would detach that whole
        // subtree from the scene — the document would still validate, because
        // the cycle is unreachable from `scene.nodes`, and the nodes would
        // simply stop existing.
        if (hit.node.type === 'group' && findNode(hit.node.children, op.parentId)) {
          throw new OpError(
            'invalid_move',
            `${op.parentId} is inside ${op.nodeId}, so moving ${op.nodeId} into it would ` +
              `detach both from the scene`,
          )
        }
        target = parent.node.children
      }
      // Lift out first, so `index` names a slot in the list as it will be —
      // which makes index 0 backmost whether or not the node started here.
      const [node] = hit.siblings.splice(hit.index, 1)
      target.splice(Math.min(op.index, target.length), 0, node!)
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

    case 'scene.setCamera': {
      const scene = requireScene(doc, op.sceneId)
      // Sorted here for the same reason track.set sorts: the sampler walks
      // keyframes in order and would interpolate backwards otherwise.
      scene.camera = {
        ...op.camera,
        tracks: op.camera.tracks.map((t) => ({
          ...t,
          keyframes: [...t.keyframes].sort((a, b) => a.t - b.t),
        })),
      }
      return
    }
    case 'scene.clearCamera': {
      delete requireScene(doc, op.sceneId).camera
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

    case 'audio.addTrack': {
      const tracks = (doc.audio ??= [])
      if (tracks.some((t) => t.id === op.track.id)) {
        throw new OpError('duplicate_id', `audio track ${op.track.id} already exists`)
      }
      tracks.splice(op.index ?? tracks.length, 0, op.track)
      return
    }
    case 'audio.removeTrack': {
      const i = doc.audio?.findIndex((t) => t.id === op.trackId) ?? -1
      if (i === -1) throw new OpError('track_not_found', `audio track ${op.trackId} not found`)
      doc.audio!.splice(i, 1)
      // An empty list and no list mean the same thing; keep one of them so two
      // documents that sound identical compare identical.
      if (doc.audio!.length === 0) delete doc.audio
      return
    }
    case 'audio.updateTrack': {
      Object.assign(requireAudioTrack(doc, op.trackId), op.patch)
      return
    }

    case 'audio.addClip': {
      const track = requireAudioTrack(doc, op.trackId)
      if (track.clips.some((c) => c.id === op.clip.id)) {
        throw new OpError('duplicate_id', `clip ${op.clip.id} already exists`)
      }
      track.clips.push(op.clip)
      return
    }
    case 'audio.removeClip': {
      const { track } = requireAudioClip(doc, op.trackId, op.clipId)
      track.clips = track.clips.filter((c) => c.id !== op.clipId)
      return
    }
    case 'audio.updateClip': {
      Object.assign(requireAudioClip(doc, op.trackId, op.clipId).clip, op.patch)
      return
    }
    case 'audio.moveClip': {
      const { track, clip } = requireAudioClip(doc, op.fromTrackId, op.clipId)
      const to = requireAudioTrack(doc, op.toTrackId)
      if (to !== track && to.clips.some((c) => c.id === op.clipId)) {
        throw new OpError('duplicate_id', `clip ${op.clipId} already exists on ${op.toTrackId}`)
      }
      track.clips = track.clips.filter((c) => c.id !== op.clipId)
      if (op.startSec !== undefined) clip.startSec = op.startSec
      // Re-read: `track.clips = ...` above replaced the array, and when the
      // source and target lanes are the same track that new array is the one
      // the clip has to land in.
      requireAudioTrack(doc, op.toTrackId).clips.push(clip)
      return
    }
  }
}
