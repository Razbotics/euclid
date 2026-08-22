import { projectStub } from '../shared'
import type { Env } from '../env'

/**
 * Narration review is script review, not audio review (plans/010): approval
 * attaches to the *text*, so re-synthesising text the human already approved
 * (same voice) is not a new creative decision. This hash is how a take finds
 * the approval of its predecessor — stored on the asset row, matched on the
 * next synthesis.
 */
export async function ttsHash(voiceId: string | undefined, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${voiceId ?? 'default'}\n${text}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Who last set a scene's narration text — read from the event log the DO
 * already keeps, so authorship is not new state. `'user'` means the human
 * typed it (their own content never queues for their own approval); anything
 * else, including "unknown", goes to review, because unknown text defaulting
 * to approved would be the gate approving what nobody read.
 */
export async function narrationAuthor(
  env: Env,
  projectId: string,
  sceneId: string,
): Promise<string | null> {
  const res = await projectStub(env, projectId)
    .fetch(`https://do/narration-author?sceneId=${encodeURIComponent(sceneId)}`)
    .catch(() => null)
  if (!res?.ok) return null
  return ((await res.json()) as { author: string | null }).author
}

/** True when an approved narration take of exactly this (voice, text) exists. */
export async function hasApprovedTts(
  env: Env,
  projectId: string,
  hash: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT id FROM assets
     WHERE project_id = ? AND kind = 'audio' AND tts_hash = ? AND review_status = 'approved'
     LIMIT 1`,
  )
    .bind(projectId, hash)
    .first<{ id: string }>()
  return !!row
}
