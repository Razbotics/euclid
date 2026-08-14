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
