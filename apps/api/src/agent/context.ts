import { findNode, type EuclidDoc, type EuclidNode, type Op } from '@euclid/dsl'
import { AccessError, docOf, requireProjectAccess, submitOps } from '../shared'
import type { Env } from '../env'
import { CapabilityError, accessKind, type AgentCtx } from './types'

/**
 * Build the context handlers run in.
 *
 * Every lookup failure here becomes a CapabilityError whose message names what
 * *does* exist. The agent has no shell and no stack trace: an error is the only
 * teacher it gets, so "scene sc_1 not found (have: sc_ab12 "Intro")" is worth
 * more than the status code that used to come back over the service binding.
 */
export function makeCtx(env: Env, userId: string, origin: string): AgentCtx {
  const ctx: AgentCtx = {
    env,
    userId,
    origin,

    async requireProject(projectId: string): Promise<void> {
      try {
        await requireProjectAccess(env, projectId, userId)
      } catch (e) {
        if (e instanceof AccessError) {
          throw new CapabilityError(e.message, e.status, accessKind(e.status))
        }
        throw e
      }
    },

    async getDoc(projectId: string): Promise<{ doc: EuclidDoc }> {
      await ctx.requireProject(projectId)
      const doc = await docOf(env, projectId)
      if (!doc) {
        throw new CapabilityError(`project ${projectId} has no document yet`, 404, 'not_found')
      }
      return { doc }
    },

    async submit(projectId: string, ops: Op[]) {
      await ctx.requireProject(projectId)
      try {
        return await submitOps(env, projectId, ops, { type: 'agent', id: userId })
      } catch (e) {
        // Reducer rejections (missing node, invalid patch) are the agent's
        // problem to fix, not an internal fault — surface the reducer's own
        // wording, which already names the offending op.
        throw new CapabilityError(
          `the edit was rejected: ${(e as Error).message}`,
          422,
          'rejected',
        )
      }
    },

    sceneOrThrow(doc: EuclidDoc, sceneId: string) {
      const scene = doc.scenes.find((s) => s.id === sceneId)
      if (scene) return scene
      const have = doc.scenes.map((s) => `${s.id} "${s.name}"`).join(', ') || 'none'
      throw new CapabilityError(
        `scene ${sceneId} not found. This project has: ${have}`,
        404,
        'not_found',
      )
    },

    nodeOrThrow(doc: EuclidDoc, sceneId: string, nodeId: string): EuclidNode {
      const scene = ctx.sceneOrThrow(doc, sceneId)
      const hit = findNode(scene.nodes, nodeId)
      if (hit) return hit.node
      const have = scene.nodes.map((n) => `${n.id} (${n.type})`).join(', ') || 'none'
      throw new CapabilityError(
        `node ${nodeId} not found in scene ${sceneId}. That scene has: ${have}`,
        404,
        'not_found',
      )
    },
  }
  return ctx
}
