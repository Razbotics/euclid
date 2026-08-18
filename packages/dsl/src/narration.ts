import type { EuclidDoc } from './document'
import { clipPlaySec, NARRATION_TRACK_ID } from './audio'

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

/**
 * Every sound in the document, placed on the global timeline: generated
 * narration *and* the audio tracks, in one list.
 *
 * This is `planNarration` grown up, and it exists for the same reason that one
 * did — three consumers must agree exactly, or the editor lies about the
 * export. The timeline draws from it, the preview player schedules from it,
 * and the render's ffmpeg mux builds its filter graph from it.
 *
 * Muted placements are **included, flagged** rather than dropped. The timeline
 * has to draw a muted lane (you cannot unmute what you cannot see), while the
 * player and the mux skip them — so one function serves both, and there is no
 * second place where "what plays" is decided.
 */
export interface AudioPlacement {
  /** Stable across re-plans: the clip's id, or `narration:<sceneId>`. */
  key: string
  /** `NARRATION_TRACK_ID` for generated speech, otherwise the track's id. */
  trackId: string
  assetId: string
  /** Where it starts on the global timeline. */
  startSec: number
  /** How long it plays for, after every trim. */
  playSec: number
  /** The asset's full length. */
  durationSec: number
  /** Offset into the asset that `startSec` corresponds to. */
  sourceInSec: number
  /** Track gain × clip gain, 0…1. */
  gain: number
  fadeInSec: number
  fadeOutSec: number
  muted: boolean
  label: string
}

/** Level for a clip at `local` seconds into it — the fades, as one number. */
export function gainAt(p: AudioPlacement, local: number): number {
  if (local < 0 || local > p.playSec) return 0
  const rise = p.fadeInSec > 0 ? Math.min(1, local / p.fadeInSec) : 1
  const fall =
    p.fadeOutSec > 0 ? Math.min(1, Math.max(0, (p.playSec - local) / p.fadeOutSec)) : 1
  return p.gain * Math.min(rise, fall)
}

export function planAudio(doc: EuclidDoc): AudioPlacement[] {
  const total = doc.scenes.reduce((n, s) => n + s.duration, 0)
  const placements: AudioPlacement[] = []

  for (const p of planNarration(doc)) {
    placements.push({
      key: `narration:${p.sceneId}`,
      trackId: NARRATION_TRACK_ID,
      assetId: p.assetId,
      startSec: p.startSec,
      playSec: p.playSec,
      durationSec: p.durationSec,
      sourceInSec: 0,
      gain: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
      muted: false,
      label: 'narration',
    })
  }

  for (const track of doc.audio ?? []) {
    for (const clip of track.clips) {
      // Cut at the end of the video, exactly as narration is cut at the end of
      // its scene: a clip hanging past the last frame is silence nobody hears
      // and an ffmpeg input nobody needs.
      const playSec = Math.min(clipPlaySec(clip), Math.max(0, total - clip.startSec))
      if (playSec <= 0) continue
      const gain = (track.gain ?? 1) * (clip.gain ?? 1)
      placements.push({
        key: clip.id,
        trackId: track.id,
        assetId: clip.assetId,
        startSec: clip.startSec,
        playSec,
        durationSec: clip.durationSec,
        sourceInSec: clip.sourceInSec ?? 0,
        gain,
        // A fade cannot outlast the clip it is on, and two fades cannot
        // overlap into a clip that never reaches its own level.
        fadeInSec: Math.min(clip.fadeInSec ?? 0, playSec),
        fadeOutSec: Math.min(clip.fadeOutSec ?? 0, playSec),
        muted: !!track.muted,
        label: clip.name ?? track.name,
      })
    }
  }

  // Sort by start time only. Array#sort is stable, so clips that begin at the
  // same instant keep the order they were built in — narration first, then
  // tracks in document order — which is both deterministic and the order a
  // human reading the render log expects.
  return placements.sort((a, b) => a.startSec - b.startSec)
}

/** What the export will actually contain — muted lanes removed. */
export const audibleAudio = (doc: EuclidDoc): AudioPlacement[] =>
  planAudio(doc).filter((p) => !p.muted && p.gain > 0)
