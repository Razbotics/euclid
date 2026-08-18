import { z } from 'zod'
import { LIMITS } from './limits'

/**
 * Audio tracks: music, sound effects, and anything else that is not narration.
 *
 * Four decisions shape this, and each one is a fork that could have gone the
 * other way:
 *
 * 1. **Clips are placed in global time, not anchored to a scene.** Narration
 *    is scene-scoped because a line belongs to the shot it explains; a music
 *    bed is the opposite — it runs *across* cuts, and anchoring it to scene 1
 *    would make it jump whenever scene 1's duration changed. The cost is
 *    honest and worth naming: re-timing an early scene slides every later
 *    scene under a bed that stays put.
 * 2. **`muted` lives in the document; solo does not.** Muting a track changes
 *    what the export contains, so it is part of the work. Solo is a monitoring
 *    choice you make for ten seconds while checking a mix — it belongs to the
 *    editor's local state, and writing it into a shared document would let one
 *    person's listening silently change everyone's render.
 * 3. **Gain attenuates only (0…1).** `HTMLMediaElement.volume` cannot exceed
 *    1, so a document allowing 1.5 would preview at a different level than it
 *    exports. Making a clip louder is what a mastering pass is for.
 * 4. **A clip carries `durationSec`** — the asset's full length, copied in when
 *    it was placed. The timeline needs to draw a clip before the audio has
 *    loaded, and the mux needs to trim without fetching the file twice.
 */
export interface AudioClip {
  id: string
  assetId: string
  /** Where the clip starts on the **global** timeline. */
  startSec: number
  /** The asset's full length, as recorded when the clip was placed. */
  durationSec: number
  /** How much of the asset to play from `sourceInSec`. Absent = the rest of it. */
  playSec?: number
  /** Trim from the head of the asset. */
  sourceInSec?: number
  /** 0…1. Absent = 1. */
  gain?: number
  fadeInSec?: number
  fadeOutSec?: number
  /** What the clip is called on the timeline; falls back to the file's name. */
  name?: string
}

export type AudioTrackKind = 'music' | 'sfx' | 'voice'

export interface AudioTrack {
  id: string
  name: string
  kind: AudioTrackKind
  /** In the document because it changes the export. Solo is editor-only state. */
  muted?: boolean
  /** 0…1, multiplied with each clip's own gain. */
  gain?: number
  clips: AudioClip[]
}

export const AudioClipSchema: z.ZodType<AudioClip> = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  startSec: z.number().min(0).max(LIMITS.maxDurationSec),
  durationSec: z.number().positive().max(LIMITS.maxDurationSec),
  playSec: z.number().positive().max(LIMITS.maxDurationSec).optional(),
  sourceInSec: z.number().min(0).max(LIMITS.maxDurationSec).optional(),
  gain: z.number().min(0).max(1).optional(),
  fadeInSec: z.number().min(0).max(LIMITS.maxDurationSec).optional(),
  fadeOutSec: z.number().min(0).max(LIMITS.maxDurationSec).optional(),
  name: z.string().optional(),
})

export const AudioTrackSchema: z.ZodType<AudioTrack> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.union([z.literal('music'), z.literal('sfx'), z.literal('voice')]),
  muted: z.boolean().optional(),
  gain: z.number().min(0).max(1).optional(),
  clips: z.array(AudioClipSchema).max(LIMITS.maxClipsPerTrack),
})

/** The id of the built-in lane `planAudio` reports generated narration on. */
export const NARRATION_TRACK_ID = 'narration'

/** How much of `clip` actually plays, before the document's end is considered. */
export function clipPlaySec(clip: AudioClip): number {
  const available = Math.max(0, clip.durationSec - (clip.sourceInSec ?? 0))
  return Math.min(clip.playSec ?? available, available)
}
