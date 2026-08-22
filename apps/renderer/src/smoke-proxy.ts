/**
 * The pure half of proxy generation (plans/003 §5): which files want one, what
 * shape it takes, and the flags that carry it.
 * Run: pnpm --filter @euclid/renderer exec tsx src/smoke-proxy.ts
 *
 * No network, no ffmpeg, no database — this is the part that can be wrong in a
 * way a running system reports minutes late, or not at all. An odd dimension
 * fails the encode after the whole file has been read; a keyframe interval
 * ffmpeg quietly ignores produces a proxy that is smaller and no faster to
 * scrub, which nothing would ever complain about.
 */
import assert from 'node:assert'
import { PROXY, needsProxy, proxySize } from '@euclid/dsl'
import { buildProxyArgs } from './proxy'

// ---------- which files want one ----------
const video = (over: Partial<Parameters<typeof needsProxy>[0]> = {}) => ({
  kind: 'video',
  width: 1920,
  height: 1080,
  bytes: 1024,
  ...over,
})

assert.ok(needsProxy(video()), '1080p wants a proxy on height alone')
assert.ok(!needsProxy(video({ width: 640, height: 360 })), 'a small, short clip does not')
assert.ok(
  needsProxy(video({ width: 640, height: 360, bytes: PROXY.maxDirectBytes + 1 })),
  'but the same size at length or bitrate does — the ceiling is bytes as well as pixels',
)
assert.ok(
  !needsProxy({ kind: 'image', width: 4000, height: 3000, bytes: 20e6 }),
  'only video is proxied: an image is one texture, not a seek per frame',
)
assert.ok(
  !needsProxy(video({ width: null, height: null })),
  'an unprobed file has no dimensions to scale to, so it is not yet askable',
)

// ---------- the shape it takes ----------
for (const [w, h] of [
  [1920, 1080],
  [1280, 720],
  [3840, 2160],
  [1080, 1920], // portrait, the native shape of most of what this is pointed at
  [1440, 1440],
  [1281, 721], // deliberately odd on both axes
] as const) {
  const p = proxySize(w, h)
  assert.equal(p.width % 2, 0, `${w}x${h} → width ${p.width} must be even`)
  assert.equal(p.height % 2, 0, `${w}x${h} → height ${p.height} must be even`)
  assert.ok(p.height <= PROXY.maxHeight, `${w}x${h} → ${p.height} exceeds the ceiling`)
  // Aspect within half a pixel of the source, or a clip would be subtly
  // stretched in the editor and correct in the export — the worst kind of
  // difference, because it looks like a layout bug in the document.
  const drift = Math.abs(p.width / p.height - w / h)
  assert.ok(drift < 0.02, `${w}x${h} → ${p.width}x${p.height} distorts the aspect by ${drift}`)
}

const small = proxySize(320, 240)
assert.deepEqual(
  small,
  { width: 320, height: 240 },
  'scaling is downward only — a proxy that upscaled would be bigger than the file it stands in for',
)

// ---------- the flags ----------
const args = buildProxyArgs('/tmp/in.mp4', '/tmp/out.mp4', { width: 960, height: 540 }, 30)
const at = (flag: string) => args[args.indexOf(flag) + 1]
assert.equal(at('-vf'), 'scale=960:540', 'the computed size reaches ffmpeg as numbers')
assert.equal(at('-g'), '30', 'a keyframe a second at 30fps')
assert.equal(at('-keyint_min'), '30')
assert.equal(
  at('-sc_threshold'),
  '0',
  'x264 must not substitute scene-change keyframes for the regular ones',
)
assert.ok(args.includes('-an'), 'no audio: the editor plays sound from audio tracks, not from this')
assert.equal(at('-movflags'), '+faststart', 'seekable before the last byte lands')
assert.equal(args.at(-1), '/tmp/out.mp4', 'output last, as ffmpeg requires')

const gopFor = (fps: number | null) => {
  const a = buildProxyArgs('in', 'out', { width: 2, height: 2 }, fps)
  return a[a.indexOf('-g') + 1]
}
assert.equal(gopFor(60), '60', 'the interval follows the frame rate, so it stays one second')
assert.equal(gopFor(23.976), '24', 'and rounds to whole frames')
assert.equal(
  gopFor(null),
  '30',
  'an unmeasurable frame rate falls back rather than putting NaN between keyframes',
)

console.log(
  `proxy smoke OK — ${PROXY.maxHeight}p ceiling, ${PROXY.gopSeconds}s keyframe interval; ` +
    `six aspect ratios stay even and undistorted, and scaling is downward only.`,
)
