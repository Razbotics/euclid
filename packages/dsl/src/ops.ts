import { z } from 'zod'
import {
  CameraSchema,
  CanvasSchema,
  ColorSchema,
  NarrationSchema,
  NodeSchema,
  SceneSchema,
  TrackSchema,
  type Camera,
  type Canvas,
  type Narration,
  type EuclidNode,
  type Scene,
  type Track,
} from './document'
import { AudioClipSchema, AudioTrackSchema, type AudioClip, type AudioTrack } from './audio'
import { LIMITS } from './limits'

/**
 * The op vocabulary — the ONLY way any writer (MCP agent, editor UI, system)
 * mutates a document. The Durable Object serializes envelopes into an event log
 * and broadcasts them; the frontend applies the same ops optimistically.
 */

const ScenePatchSchema = z
  .object({ name: z.string().min(1), duration: z.number().positive(), background: ColorSchema })
  .partial()

/**
 * Node patches are a shallow key/value merge. `id`, `type` and `children` are
 * immutable through patches; the reducer strips them, merges, then re-validates
 * the whole node against NodeSchema so an invalid patch can never corrupt a doc.
 */
const NodePatchSchema = z.record(z.string(), z.unknown())

export const OpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project.rename'), name: z.string().min(1) }),
  z.object({ kind: z.literal('project.setCanvas'), canvas: CanvasSchema }),

  z.object({ kind: z.literal('scene.add'), scene: SceneSchema, index: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('scene.remove'), sceneId: z.string() }),
  z.object({ kind: z.literal('scene.update'), sceneId: z.string(), patch: ScenePatchSchema }),
  z.object({ kind: z.literal('scene.move'), sceneId: z.string(), index: z.number().int().min(0) }),

  z.object({
    kind: z.literal('node.add'),
    sceneId: z.string(),
    node: NodeSchema,
    /** Optional group to insert into; defaults to scene root. */
    parentId: z.string().optional(),
    index: z.number().int().min(0).optional(),
  }),
  /**
   * Move a node to another slot — the op behind draw order, since draw order
   * **is** document order among siblings.
   *
   * Names the node by id and never carries its contents, which is what makes it
   * safe under the DO's rebase-on-409 retry: a remove+add pair would re-insert
   * the copy the writer read, silently reverting whatever landed in between.
   *
   * `parentId` reads exactly as it does on `node.add` — omitted means the scene
   * root — and `index` is the destination slot in the target list *after* the
   * node has been lifted out of its old one, so index 0 is always backmost.
   */
  z.object({
    kind: z.literal('node.move'),
    sceneId: z.string(),
    nodeId: z.string(),
    parentId: z.string().optional(),
    index: z.number().int().min(0),
  }),
  z.object({ kind: z.literal('node.remove'), sceneId: z.string(), nodeId: z.string() }),
  z.object({ kind: z.literal('node.update'), sceneId: z.string(), nodeId: z.string(), patch: NodePatchSchema }),

  z.object({ kind: z.literal('track.set'), sceneId: z.string(), nodeId: z.string(), track: TrackSchema }),
  z.object({ kind: z.literal('track.remove'), sceneId: z.string(), nodeId: z.string(), property: z.string() }),

  /**
   * The camera is set whole rather than patched, and its tracks ride along.
   * A camera has three properties that are read together to mean "the framing",
   * so a partial op would let two writers interleave into a framing neither
   * asked for — and there is exactly one camera per scene, so there is no
   * addressing to save by splitting it up.
   */
  z.object({ kind: z.literal('scene.setCamera'), sceneId: z.string(), camera: CameraSchema }),
  z.object({ kind: z.literal('scene.clearCamera'), sceneId: z.string() }),

  z.object({ kind: z.literal('narration.set'), sceneId: z.string(), narration: NarrationSchema }),
  z.object({ kind: z.literal('narration.clear'), sceneId: z.string() }),

  /**
   * Audio lanes. A track is added and removed whole, but a clip is *patched* —
   * the opposite of the camera above, and for the opposite reason: dragging a
   * clip along its lane touches one number many times a second, and sending a
   * whole track on every mouse move would make two people editing different
   * clips on one lane clobber each other.
   */
  z.object({ kind: z.literal('audio.addTrack'), track: AudioTrackSchema, index: z.number().int().min(0).optional() }),
  z.object({ kind: z.literal('audio.removeTrack'), trackId: z.string() }),
  z.object({
    kind: z.literal('audio.updateTrack'),
    trackId: z.string(),
    patch: z
      .object({
        name: z.string().min(1),
        kind: z.union([z.literal('music'), z.literal('sfx'), z.literal('voice')]),
        muted: z.boolean(),
        gain: z.number().min(0).max(1),
      })
      .partial(),
  }),
  z.object({ kind: z.literal('audio.addClip'), trackId: z.string(), clip: AudioClipSchema }),
  z.object({ kind: z.literal('audio.removeClip'), trackId: z.string(), clipId: z.string() }),
  z.object({
    kind: z.literal('audio.updateClip'),
    trackId: z.string(),
    clipId: z.string(),
    patch: z
      .object({
        startSec: z.number().min(0).max(LIMITS.maxDurationSec),
        playSec: z.number().positive().max(LIMITS.maxDurationSec),
        sourceInSec: z.number().min(0).max(LIMITS.maxDurationSec),
        gain: z.number().min(0).max(1),
        fadeInSec: z.number().min(0).max(LIMITS.maxDurationSec),
        fadeOutSec: z.number().min(0).max(LIMITS.maxDurationSec),
        name: z.string(),
      })
      .partial(),
  }),
  /** Dragging a clip to another lane. One op, so it can never exist twice or not at all. */
  z.object({
    kind: z.literal('audio.moveClip'),
    fromTrackId: z.string(),
    toTrackId: z.string(),
    clipId: z.string(),
    startSec: z.number().min(0).max(LIMITS.maxDurationSec).optional(),
  }),
])
export type Op = z.infer<typeof OpSchema>

export const ActorSchema = z.object({
  type: z.enum(['agent', 'user', 'system']),
  id: z.string().optional(),
})
export type Actor = z.infer<typeof ActorSchema>

/**
 * A batch of ops applied atomically against a known document version.
 * If baseVersion doesn't match the server's current version the whole
 * envelope is rejected with 409 and the writer refetches + rebases.
 */
export const OpEnvelopeSchema = z.object({
  id: z.string().min(1),
  baseVersion: z.number().int().min(0),
  actor: ActorSchema,
  ops: z.array(OpSchema).min(1).max(LIMITS.maxOpsPerEnvelope),
})
export type OpEnvelope = z.infer<typeof OpEnvelopeSchema>

// Convenience constructors (used by MCP tools and the editor)
export const op = {
  addScene: (scene: Scene, index?: number): Op => ({ kind: 'scene.add', scene, index }),
  updateScene: (sceneId: string, patch: Partial<Pick<Scene, 'name' | 'duration' | 'background'>>): Op => ({
    kind: 'scene.update',
    sceneId,
    patch,
  }),
  addNode: (sceneId: string, node: EuclidNode, parentId?: string, index?: number): Op => ({
    kind: 'node.add',
    sceneId,
    node,
    parentId,
    index,
  }),
  updateNode: (sceneId: string, nodeId: string, patch: Record<string, unknown>): Op => ({
    kind: 'node.update',
    sceneId,
    nodeId,
    patch,
  }),
  removeNode: (sceneId: string, nodeId: string): Op => ({ kind: 'node.remove', sceneId, nodeId }),
  moveNode: (sceneId: string, nodeId: string, index: number, parentId?: string): Op => ({
    kind: 'node.move',
    sceneId,
    nodeId,
    index,
    parentId,
  }),
  setTrack: (sceneId: string, nodeId: string, track: Track): Op => ({ kind: 'track.set', sceneId, nodeId, track }),
  setNarration: (sceneId: string, narration: Narration): Op => ({ kind: 'narration.set', sceneId, narration }),
  setCamera: (sceneId: string, camera: Camera): Op => ({ kind: 'scene.setCamera', sceneId, camera }),
  clearCamera: (sceneId: string): Op => ({ kind: 'scene.clearCamera', sceneId }),
  setCanvas: (canvas: Canvas): Op => ({ kind: 'project.setCanvas', canvas }),
  addAudioTrack: (track: AudioTrack, index?: number): Op => ({ kind: 'audio.addTrack', track, index }),
  removeAudioTrack: (trackId: string): Op => ({ kind: 'audio.removeTrack', trackId }),
  updateAudioTrack: (
    trackId: string,
    patch: Partial<Pick<AudioTrack, 'name' | 'kind' | 'muted' | 'gain'>>,
  ): Op => ({ kind: 'audio.updateTrack', trackId, patch }),
  addAudioClip: (trackId: string, clip: AudioClip): Op => ({ kind: 'audio.addClip', trackId, clip }),
  removeAudioClip: (trackId: string, clipId: string): Op => ({ kind: 'audio.removeClip', trackId, clipId }),
  updateAudioClip: (
    trackId: string,
    clipId: string,
    patch: Partial<Omit<AudioClip, 'id' | 'assetId' | 'durationSec'>>,
  ): Op => ({ kind: 'audio.updateClip', trackId, clipId, patch }),
  moveAudioClip: (fromTrackId: string, toTrackId: string, clipId: string, startSec?: number): Op => ({
    kind: 'audio.moveClip',
    fromTrackId,
    toTrackId,
    clipId,
    startSec,
  }),
}
