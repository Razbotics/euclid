import { useEffect, useMemo, useRef, useState } from 'react'
import { gainAt, planAudio, type EuclidDoc } from '@euclid/dsl'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

/**
 * How far audio may drift from the playhead before we re-seek. Correcting
 * every frame makes playback stutter — once started, the audio element keeps
 * better time than a rAF loop, so we only intervene when it has genuinely
 * slipped (a scrub, a stall, a tab throttle).
 */
const MAX_DRIFT_SEC = 0.25

interface Props {
  doc: EuclidDoc
  time: number
  playing: boolean
  /** The transport's mute — silences everything, and is not part of the document. */
  muted: boolean
  /** Track being auditioned alone, or null. Editor state: solo never exports. */
  solo: string | null
}

/**
 * The editor's mixer: narration, music and effects, all scheduled from
 * `planAudio` in @euclid/dsl — the same function the export's ffmpeg mux
 * reads — so what you hear while scrubbing is what lands in the file,
 * including trims, gains and fades.
 *
 * One `<audio>` per *placement*, not per asset: the same sting dropped three
 * times needs three elements, or the second copy would fight the first for one
 * element's `currentTime`.
 *
 * This lives in the browser shell, never in @euclid/engine: the sampler must
 * stay a pure function of (document, time), and audio is neither.
 */
export function AudioMixer({ doc, time, playing, muted, solo }: Props) {
  const placements = useMemo(() => planAudio(doc), [doc])
  const elements = useRef(new Map<string, HTMLAudioElement>())
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    for (const p of placements) {
      const el = elements.current.get(p.key)
      if (!el) continue

      // Three ways to be silent, and they mean different things: the document
      // says so (`p.muted`), the transport says so, or another lane is soloed.
      el.muted = muted || p.muted || (solo !== null && p.trackId !== solo)

      const local = time - p.startSec
      // `playSec`, not `durationSec`: audio that outruns its scene or the end
      // of the video is cut here exactly as the export cuts it with atrim.
      const active = local >= 0 && local < p.playSec
      // The fade envelope, evaluated at the playhead — the preview really does
      // fade rather than just promising to at export.
      el.volume = active ? Math.max(0, Math.min(1, gainAt(p, local))) : 0

      // Source time, not timeline time: a clip trimmed 12s into its file must
      // start playing 12s in.
      const at = p.sourceInSec + local

      if (!active) {
        if (!el.paused) el.pause()
        continue
      }
      if (!playing) {
        if (!el.paused) el.pause()
        // Scrubbing: keep the element parked at the playhead so pressing play
        // resumes from where the canvas already is.
        if (Math.abs(el.currentTime - at) > 0.05) el.currentTime = at
        continue
      }
      if (Math.abs(el.currentTime - at) > MAX_DRIFT_SEC) el.currentTime = at
      if (el.paused) {
        void el
          .play()
          .then(() => setBlocked(false))
          // Autoplay policy: the browser wants a user gesture. The play button
          // is one, but the call happens an effect later, so it can still be
          // refused — say so instead of failing silently.
          .catch(() => setBlocked(true))
      }
    }
  }, [time, playing, muted, solo, placements])

  return (
    <>
      {placements.map((p) => (
        <audio
          key={p.key}
          ref={(el) => {
            if (el) elements.current.set(p.key, el)
            else elements.current.delete(p.key)
          }}
          src={`${API}/api/assets/${p.assetId}`}
          // Assets are owner-scoped, so the session cookie has to ride along.
          crossOrigin="use-credentials"
          preload="auto"
        />
      ))}
      {blocked && <div className="audio-blocked">audio blocked — press play again</div>}
    </>
  )
}
