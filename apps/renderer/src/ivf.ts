/**
 * IVF: the smallest container ffmpeg will read VP9 out of.
 *
 * The capture path encodes VP9 in the browser and has to hand ffmpeg something
 * it can demux. WebM would mean a Matroska muxer — a dependency, or a few
 * hundred lines of EBML. IVF is a 32-byte file header and a 12-byte header per
 * frame, ffmpeg demuxes it natively (`-f ivf`), and it carries VP8/VP9/AV1.
 * That is the whole reason it is here.
 */

const FILE_HEADER = 32
const FRAME_HEADER = 12

/**
 * `frameCount` is written into the header, so it must be known up front — the
 * renderer knows how many frames a document is before it starts, and ffmpeg
 * tolerates a wrong count anyway, preferring what it actually reads.
 */
export function ivfHeader(
  width: number,
  height: number,
  fps: number,
  frameCount: number,
  fourcc: 'VP90' | 'VP80' = 'VP90',
): Buffer {
  const b = Buffer.alloc(FILE_HEADER)
  b.write('DKIF', 0, 'ascii')
  b.writeUInt16LE(0, 4) // version
  b.writeUInt16LE(FILE_HEADER, 6)
  b.write(fourcc, 8, 'ascii')
  b.writeUInt16LE(width, 12)
  b.writeUInt16LE(height, 14)
  // ffmpeg reads these as time_base.den then time_base.num, so den=fps with
  // num=1 makes the timebase 1/fps and every pts below a plain frame index.
  b.writeUInt32LE(fps, 16)
  b.writeUInt32LE(1, 20)
  b.writeUInt32LE(frameCount, 24)
  b.writeUInt32LE(0, 28)
  return b
}

/** One frame: its length, its presentation time in frames, then the payload. */
export function ivfFrame(payload: Buffer, pts: number): Buffer {
  const head = Buffer.alloc(FRAME_HEADER)
  head.writeUInt32LE(payload.byteLength, 0)
  head.writeBigUInt64LE(BigInt(pts), 4)
  return Buffer.concat([head, payload])
}
