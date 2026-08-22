import { op, ttsCost, type EuclidDoc } from '@euclid/dsl'
import { adjustCredits, getBalance } from '../billing'
import { docOf, requireProjectAccess, slugify, submitOps } from '../shared'
import { elevenLabsProvider, TtsError } from '../tts'
import { storeAsset } from './assets'
import { PlanGateError, chargePlanBudget, refundPlanBudget, reviewModeOf } from './plan'
import { hasApprovedTts, narrationAuthor, ttsHash } from './review'
import type { Env } from '../env'

export class NarrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export interface NarrationResult {
  assetId: string
  sceneId: string
  cost: number
  durationSec: number
  words: number
  sceneDuration: number
  fits: boolean
  warning?: string
  /** Where the take starts with the human (plans/010). */
  reviewStatus: 'pending' | 'approved'
  /** Why it auto-approved, when it did. */
  reviewReason?: string
}

/**
 * Synthesize a scene's narration, store the audio as an asset, and write the
 * result back into the document as a `system` op — so the editor sees it
 * appear live and the agent can read the real duration before choreographing
 * against it.
 *
 * Credits are debited up front (the price is a function of the text, so it's
 * knowable before synthesis) and refunded if anything after the debit fails.
 *
 * Lives here rather than in the agent catalog because credits, R2 and the path
 * into the Durable Object all meet at this one boundary — debit → synthesize →
 * store → submit is one refund path, and splitting it would create two.
 */
export async function generateSceneNarration(
  env: Env,
  projectId: string,
  sceneId: string,
  userId: string,
  body: {
    text?: string
    voiceId?: string
    /**
     * Who wrote an explicitly-passed `text` — 'human' from the editor's
     * narration panel, 'agent' from the capability. When text comes from the
     * document instead, authorship is read from the event log.
     */
    textAuthor?: 'human' | 'agent'
  } = {},
): Promise<NarrationResult> {
  await requireProjectAccess(env, projectId, userId)
  const doc: EuclidDoc | null = await docOf(env, projectId)
  if (!doc) throw new NarrationError('project_not_found', 'project has no document', 404)

  const scene = doc.scenes.find((s) => s.id === sceneId)
  if (!scene) throw new NarrationError('scene_not_found', `scene ${sceneId} not found`, 404, { sceneId })

  const text = (body.text ?? scene.narration?.text ?? '').trim()
  if (!text) {
    throw new NarrationError(
      'no_narration_text',
      'set narration text first with set_narration, or pass text',
      400,
    )
  }
  const voiceId = body.voiceId ?? scene.narration?.voiceId

  const cost = ttsCost(text)
  const balance = await getBalance(env, userId)
  if (balance < cost) {
    throw new NarrationError('insufficient_credits', 'not enough credits', 402, {
      required: cost,
      balance,
    })
  }

  // Narration review is script review (plans/010): decide where this take
  // will start with the human before anything is spent. Approval attaches to
  // the (voice, text) pair — re-synthesis of approved text is not a new
  // creative decision — and the human's own words never queue for their own
  // approval. Unknown authorship goes to review: defaulting it to approved
  // would be the gate approving what nobody read.
  const hash = await ttsHash(voiceId, text)
  let review: { status: 'pending' | 'approved'; via?: 'auto'; note?: string } = {
    status: 'pending',
  }
  if (!(await reviewModeOf(env, projectId))) {
    review = { status: 'approved', via: 'auto', note: 'review mode off' }
  } else if (await hasApprovedTts(env, projectId, hash)) {
    review = { status: 'approved', via: 'auto', note: 're-synthesis of approved text' }
  } else {
    const author = body.text
      ? body.textAuthor === 'human'
        ? 'user'
        : 'agent'
      : await narrationAuthor(env, projectId, sceneId)
    if (author === 'user') {
      review = { status: 'approved', via: 'auto', note: 'human-authored script' }
    }
  }
  // Regenerating a scene's narration naturally revises the take it replaces;
  // the predecessor is knowable here, so lineage needs no argument.
  const revises = scene.narration?.audio?.assetId ?? null

  // The review-mode gate (plans/010): narration is a paid generation like any
  // other, so it draws down the approved plan's budget under the same rule.
  let planId: string | null = null
  try {
    planId = (await chargePlanBudget(env, projectId, 'narration', cost))?.planId ?? null
  } catch (e) {
    if (e instanceof PlanGateError) throw new NarrationError(e.code, e.message, e.status)
    throw e
  }

  // One id ties the debit and any refund together in the ledger, the same way
  // a job id does for renders.
  const ttsId = crypto.randomUUID()
  await adjustCredits(env, userId, -cost, `tts:${ttsId} (${sceneId})`)
  const refund = async (why: string) => {
    await adjustCredits(env, userId, cost, `refund:${ttsId} (${why})`)
    if (planId) await refundPlanBudget(env, projectId, planId, cost)
  }

  let synthesis
  try {
    synthesis = await elevenLabsProvider(env.ELEVENLABS_API_KEY).synthesize({ text, voiceId })
  } catch (e) {
    const detail = e instanceof TtsError ? e.message : String(e)
    await refund('tts failed')
    throw new NarrationError('tts_failed', detail, 502, { refunded: cost })
  }

  let assetId: string
  try {
    assetId = (
      await storeAsset(env, projectId, {
        kind: 'audio',
        mime: synthesis.mime,
        durationSec: synthesis.durationSec,
        // Named after the scene, so the explorer reads as a project's files
        // rather than a pile of uuids.
        path: `/narration/${slugify(scene.name)}.mp3`,
        body: synthesis.audio,
        review: { ...review, revises, ttsHash: hash },
      })
    ).assetId
    await submitOps(
      env,
      projectId,
      [
        op.setNarration(sceneId, {
          text,
          voiceId,
          audio: { assetId, durationSec: synthesis.durationSec, words: synthesis.words },
        }),
      ],
      { type: 'system' },
    )
  } catch (e) {
    await refund('store failed')
    throw new NarrationError('narration_store_failed', String(e), 500, { refunded: cost })
  }

  // Overflow is reported, not enforced: the mismatch is only knowable after
  // synthesis, so rejecting here would discard audio the user just paid for
  // and make the retry cost again. The caller still decides what to change.
  const fits = synthesis.durationSec <= scene.duration
  const suggested = Math.ceil(synthesis.durationSec * 10) / 10
  return {
    assetId,
    sceneId,
    cost,
    durationSec: synthesis.durationSec,
    words: synthesis.words.length,
    sceneDuration: scene.duration,
    fits,
    reviewStatus: review.status,
    ...(review.note ? { reviewReason: review.note } : {}),
    ...(fits
      ? {}
      : {
          warning:
            `narration runs ${synthesis.durationSec.toFixed(2)}s but scene "${sceneId}" is ` +
            `${scene.duration}s, so ${(synthesis.durationSec - scene.duration).toFixed(2)}s would be cut. ` +
            `The audio is saved and already in the document — either call ` +
            `fit_scene_to_narration(sceneId="${sceneId}") or ` +
            `update_scene(sceneId="${sceneId}", duration=${suggested}), or shorten the script and regenerate.`,
        }),
  }
}
