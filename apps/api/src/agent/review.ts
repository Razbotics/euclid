import { linkAsset } from '../services/assets'
import { reviewModeOf } from '../services/plan'
import { AccessError } from '../shared'
import { CapabilityError, type AgentCtx } from './types'

/**
 * Placement implies membership (plans/010 phase 4): placing an owned library
 * asset into a project links it there, so the explorer shows what the
 * document uses. Idempotent — an asset already linked links no further.
 */
export async function ensureLinked(
  ctx: AgentCtx,
  projectId: string,
  assetId: string,
): Promise<{ freshlyLinked: boolean }> {
  try {
    const r = await linkAsset(ctx.env, projectId, assetId, ctx.userId)
    return { freshlyLinked: !r.already }
  } catch (e) {
    if (e instanceof AccessError) throw new CapabilityError(e.message, e.status)
    throw e
  }
}

/**
 * The placement gate (plans/010, phase 2): while a project is in review mode,
 * an asset reaches the document only after the human has approved it. Called
 * by every placement capability — add_image, add_video, import_mesh,
 * add_audio_clip — with whatever row shape that capability already loaded.
 *
 * Narration is the deliberate exception: its audio is attached to the scene
 * on generation (that is how it is auditioned and how timings exist to
 * choreograph against), and the render last-net is what holds an unapproved
 * take out of the finished video.
 */
export async function assertPlacementApproved(
  ctx: AgentCtx,
  projectId: string,
  asset: { id: string; reviewStatus?: string | null; reviewNote?: string | null },
): Promise<void> {
  const status = asset.reviewStatus ?? 'approved'
  if (status === 'approved') return
  if (!(await reviewModeOf(ctx.env, projectId))) return
  if (status === 'rejected') {
    throw new CapabilityError(
      `asset ${asset.id} was rejected by the human` +
        (asset.reviewNote ? ` — "${asset.reviewNote}"` : '') +
        `. Regenerate it (pass revises: "${asset.id}" so the versions stay linked), ` +
        `call request_review on the new file, and place that one once approved.`,
      403,
    )
  }
  throw new CapabilityError(
    `asset ${asset.id} is pending review — the human has not seen it yet. ` +
      `Call request_review(assetIds: ["${asset.id}"]) and STOP until they answer; ` +
      `place it only once approved.`,
    403,
  )
}
