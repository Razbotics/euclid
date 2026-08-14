import type { EuclidDoc } from '@euclid/dsl'

/**
 * Where each scene's narration sits on the global audio timeline, and how much
 * of it may play. Pure — separated from downloading so the offset and trim
 * decisions can be tested without a render or a network call.
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
 * Scenes without narration contribute nothing: the silence between clips comes
 * from placing them at offsets, not from padding files.
 *
 * Narration may outrun its scene — `generate_narration` warns but keeps the
 * audio rather than billing a retry — so it is cut at the scene boundary. That
 * matches what captions do (`clampToScene` in packages/dsl), and it prevents
 * one scene's voice from playing over the next scene's frames.
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
 * Video always comes from the PNG pipe on stdin (input 0); each narration clip
 * is an extra input placed on the timeline with `adelay`.
 *
 * `apad` + `-shortest` is what makes the audio track span the whole video:
 * without it the file would end at the last word, truncating a trailing silent
 * scene.
 */
export function buildFfmpegArgs(
  fps: number,
  clips: (NarrationPlacement & { path: string })[],
  outPath: string,
): string[] {
  const inputs = ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-']
  for (const clip of clips) inputs.push('-i', clip.path)
  const video = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18']

  if (clips.length === 0) return [...inputs, ...video, outPath]

  // Normalize every clip to one format first: amix misbehaves when inputs
  // disagree on sample rate or channel layout.
  const chains = clips.map(
    (clip, i) =>
      `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
      `atrim=0:${clip.playSec.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `adelay=${Math.round(clip.startSec * 1000)}:all=1[a${i}]`,
  )
  const mixInputs = clips.map((_, i) => `[a${i}]`).join('')
  const filter =
    `${chains.join(';')};` +
    // normalize=0: amix divides by input count by default, so narration would
    // get quieter the more narrated scenes a project has.
    `${mixInputs}amix=inputs=${clips.length}:normalize=0[mixed];[mixed]apad[aout]`

  return [
    ...inputs,
    '-filter_complex', filter,
    '-map', '0:v',
    '-map', '[aout]',
    ...video,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-shortest',
    outPath,
  ]
}
