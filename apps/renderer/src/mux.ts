import type { NarrationPlacement } from '@euclid/dsl'

/**
 * ffmpeg-specific half of the mux. Placement itself (`planNarration`) lives in
 * @euclid/dsl so the editor's audio preview and this export derive the same
 * offsets and trims from the document.
 */

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
  // Move the moov atom to the front. Written last by default, which means a
  // browser streaming the URL cannot describe *any* track — including audio —
  // until it has the whole file. Costs one extra pass over the output.
  const web = ['-movflags', '+faststart']

  if (clips.length === 0) return [...inputs, ...video, ...web, outPath]

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
