import type { AudioPlacement } from '@euclid/dsl'

/**
 * ffmpeg-specific half of the mux. Placement itself (`planAudio`) lives in
 * @euclid/dsl so the editor's audio preview and this export derive the same
 * offsets, trims, gains and fades from the document.
 */

/** Three decimals is a millisecond — finer than any of this is audible. */
const s = (n: number) => n.toFixed(3)

/**
 * Video always arrives on stdin (input 0); each audio clip — narration, music
 * or effect — is an extra input placed on the timeline with `adelay`.
 *
 * `source` is which pipe: `png` is the original screenshot path, `ivf` the
 * WebCodecs one, where the browser has already encoded VP9 and the frame rate
 * comes from the IVF header's own timebase rather than a flag.
 *
 * `apad` + `-shortest` is what makes the audio track span the whole video:
 * without it the file would end at the last sound, truncating a trailing
 * silent scene.
 */
export function buildFfmpegArgs(
  fps: number,
  clips: (AudioPlacement & { path: string })[],
  outPath: string,
  source: 'png' | 'ivf' = 'png',
): string[] {
  const inputs =
    source === 'ivf'
      ? ['-y', '-f', 'ivf', '-i', '-']
      : ['-y', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-']
  for (const clip of clips) inputs.push('-i', clip.path)
  const video = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18']
  // Move the moov atom to the front. Written last by default, which means a
  // browser streaming the URL cannot describe *any* track — including audio —
  // until it has the whole file. Costs one extra pass over the output.
  const web = ['-movflags', '+faststart']

  if (clips.length === 0) return [...inputs, ...video, ...web, outPath]

  // Normalize every clip to one format first: amix misbehaves when inputs
  // disagree on sample rate or channel layout — and with music in the project
  // they now routinely do, since a 44.1kHz mono effect and a 48kHz stereo bed
  // can land on the same timeline.
  const chains = clips.map((clip, i) => {
    const filters = [
      `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo`,
      // Trim in source time, then restamp: `adelay` places the result, so the
      // clip has to start at PTS 0 first or the delay stacks on the offset.
      `atrim=${s(clip.sourceInSec)}:${s(clip.sourceInSec + clip.playSec)}`,
      `asetpts=PTS-STARTPTS`,
    ]
    if (clip.gain !== 1) filters.push(`volume=${s(clip.gain)}`)
    // Fades are applied *after* volume, so `afade` ramps to the clip's own
    // level rather than to full scale — a 0.4-gain bed must not swell to 1.0
    // as it fades in.
    if (clip.fadeInSec > 0) filters.push(`afade=t=in:st=0:d=${s(clip.fadeInSec)}`)
    if (clip.fadeOutSec > 0) {
      filters.push(`afade=t=out:st=${s(Math.max(0, clip.playSec - clip.fadeOutSec))}:d=${s(clip.fadeOutSec)}`)
    }
    filters.push(`adelay=${Math.round(clip.startSec * 1000)}:all=1`)
    return `[${i + 1}:a]${filters.join(',')}[a${i}]`
  })

  const mixInputs = clips.map((_, i) => `[a${i}]`).join('')
  const filter =
    `${chains.join(';')};` +
    // normalize=0: amix divides by input count by default, so narration would
    // get quieter the more narrated scenes a project has — and quieter again
    // the moment a music bed joined it.
    `${mixInputs}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[mixed];[mixed]apad[aout]`

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
