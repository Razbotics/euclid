import { z } from 'zod'
import {
  CanvasSchema,
  ColorSchema,
  NarrationSchema,
  NodeSchema,
  SceneSchema,
  TrackSchema,
  type Canvas,
  type Narration,
  type EuclidNode,
  type Scene,
  type Track,
} from './document'
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
  z.object({ kind: z.literal('node.remove'), sceneId: z.string(), nodeId: z.string() }),
  z.object({ kind: z.literal('node.update'), sceneId: z.string(), nodeId: z.string(), patch: NodePatchSchema }),

  z.object({ kind: z.literal('track.set'), sceneId: z.string(), nodeId: z.string(), track: TrackSchema }),
  z.object({ kind: z.literal('track.remove'), sceneId: z.string(), nodeId: z.string(), property: z.string() }),

  z.object({ kind: z.literal('narration.set'), sceneId: z.string(), narration: NarrationSchema }),
  z.object({ kind: z.literal('narration.clear'), sceneId: z.string() }),
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
  setTrack: (sceneId: string, nodeId: string, track: Track): Op => ({ kind: 'track.set', sceneId, nodeId, track }),
  setNarration: (sceneId: string, narration: Narration): Op => ({ kind: 'narration.set', sceneId, narration }),
  setCanvas: (canvas: Canvas): Op => ({ kind: 'project.setCanvas', canvas }),
}
