import { PROXY } from '@euclid/dsl'

/**
 * ffmpeg-specific half of proxy generation. What a proxy *is* — how tall, how
 * often keyframed, which sources want one — lives in `@euclid/dsl` as numbers,
 * for the reason `planAudio` does: the decision is shared and the flags are not.
 *
 * Split out and pure so the argument list can be checked without spawning
 * anything, which is where the two settings that are easy to get silently wrong
 * live: an odd dimension (H.264 refuses it in yuv420p, minutes into the job)
 * and a keyframe interval ffmpeg is free to ignore.
 */
export function buildProxyArgs(
  src: string,
  out: string,
  size: { width: number; height: number },
  fps: number | null,
): string[] {
  // A keyframe a second, in frames. Sources arrive with a frame rate ffprobe
  // could not read, so 30 stands in — the interval only has to be roughly a
  // second for the seek bound to hold.
  const gop = Math.max(1, Math.round((fps && fps > 0 ? fps : 30) * PROXY.gopSeconds))
  return [
    '-y',
    '-v', 'error',
    '-i', src,
    '-vf', `scale=${size.width}:${size.height}`,
    '-c:v', 'libx264',
    // The proxy is thrown away the moment the source is deleted, so encoder
    // time is worth more than the bytes it would save.
    '-preset', 'veryfast',
    '-crf', String(PROXY.crf),
    '-pix_fmt', 'yuv420p',
    '-g', String(gop),
    '-keyint_min', String(gop),
    // Without this x264 also emits a keyframe at every scene change and, worse,
    // may place them *instead of* the regular ones — so a long static take can
    // still end up with a ten-second gap. The point of this file is a bound on
    // seek latency, and the bound has to hold on the footage that needs it most.
    '-sc_threshold', '0',
    // No audio at all. The editor's video provider is muted and only ever copies
    // a frame out; sound on the timeline comes from audio tracks, which read
    // their own assets. Carrying it here would be bytes nothing plays.
    '-an',
    // The editor range-requests this while it downloads. With the moov atom
    // written last — the default — nothing about the file is knowable until the
    // final byte arrives, which is precisely the wait a proxy exists to remove.
    '-movflags', '+faststart',
    out,
  ]
}
