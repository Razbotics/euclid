import { op, ttsCost, type EuclidDoc } from '@euclid/dsl'
import { adjustCredits, getBalance } from '../billing'
import { docOf, requireProjectAccess, slugify, submitOps } from '../shared'
import { elevenLabsProvider, TtsError } from '../tts'
import { storeAsset } from './assets'
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
  body: { text?: string; voiceId?: string } = {},
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

  // One id ties the debit and any refund together in the ledger, the same way
  // a job id does for renders.
  const ttsId = crypto.randomUUID()
  await adjustCredits(env, userId, -cost, `tts:${ttsId} (${sceneId})`)
  const refund = (why: string) => adjustCredits(env, userId, cost, `refund:${ttsId} (${why})`)

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
