import type { EuclidDoc } from './document'

/**
 * Where each scene's narration sits on the global timeline, and how much of it
 * may play.
 *
 * A pure function of the document, the same discipline as captions and
 * rendering — and for the same reason: the editor's audio preview and the
 * export's ffmpeg mux both derive placement from here, so what you hear while
 * scrubbing is what ends up in the file.
 */
export interface NarrationPlacement {
  sceneId: string
  assetId: string
  /** where this scene begins on the global timeline */
  startSec: number
  /** how much of the clip may play before its scene ends */
  playSec: number
  /** what the document says the audio actually runs for */
  durationSec: number
}

/** True when the scene's narration had to be cut to fit. */
export const isTrimmed = (p: NarrationPlacement): boolean => p.durationSec > p.playSec

/**
 * A silent tail longer than this reads as dead air rather than breathing room.
 * Not enforced anywhere — it only decides what gets flagged to the agent.
 */
export const LONG_TAIL_SEC = 2

export interface ScenePacing {
  sceneId: string
  duration: number
  /** seconds of generated speech (0 when narration has no audio yet) */
  speechSec: number
  /** silence between the end of speech and the end of the scene */
  tailSec: number
  hasNarrationText: boolean
}

/**
 * How much of each scene is speech and how much is silence.
 *
 * The Phase 5 milestone found ~15% of a video was silent stillness, because
 * narration is scene-scoped and nothing reasoned about the *gap* between
 * speech ending and the scene ending. Nothing enforces a pace — this just
 * makes the gap visible in the outline the agent already reads, so it is a
 * choice rather than an accident.
 */
export function scenePacing(doc: EuclidDoc): ScenePacing[] {
  return doc.scenes.map((scene) => {
    const audio = scene.narration?.audio
    // Clips are placed at the scene start and cut at its end, so speech can
    // never exceed the scene however long the audio is.
    const speechSec = audio ? Math.min(audio.durationSec, scene.duration) : 0
    return {
      sceneId: scene.id,
      duration: scene.duration,
      speechSec,
      tailSec: scene.duration - speechSec,
      hasNarrationText: !!scene.narration?.text?.trim(),
    }
  })
}

export function pacingSummary(doc: EuclidDoc): {
  totalSec: number
  speechSec: number
  silentSec: number
  silentPct: number
} {
  const pacing = scenePacing(doc)
  const totalSec = pacing.reduce((n, p) => n + p.duration, 0)
  const speechSec = pacing.reduce((n, p) => n + p.speechSec, 0)
  const silentSec = totalSec - speechSec
  // Rounded to milliseconds: summing floats leaves artefacts like
  // 3.5999999999999996, and these numbers are read by humans and agents.
  const ms = (n: number) => Math.round(n * 1000) / 1000
  return {
    totalSec: ms(totalSec),
    speechSec: ms(speechSec),
    silentSec: ms(silentSec),
    silentPct: totalSec > 0 ? Math.round((silentSec / totalSec) * 100) : 0,
  }
}

/**
 * Scenes without generated audio contribute nothing: the silence between clips
 * comes from placing them at offsets, not from padding.
 *
 * Narration may outrun its scene — `generate_narration` warns but keeps the
 * audio rather than billing a retry — so it is cut at the scene boundary. That
 * matches `clampToScene` in captions.ts, and it stops one scene's voice from
 * playing over the next scene's frames.
 */
export function planNarration(doc: EuclidDoc): NarrationPlacement[] {
  const placements: NarrationPlacement[] = []
  let sceneStart = 0
  for (const scene of doc.scenes) {
    const audio = scene.narration?.audio
    if (audio?.assetId) {
      placements.push({
        sceneId: scene.id,
        assetId: audio.assetId,
        startSec: sceneStart,
        playSec: Math.min(audio.durationSec, scene.duration),
        durationSec: audio.durationSec,
      })
    }
    sceneStart += scene.duration
  }
  return placements
}
