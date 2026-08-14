import { useEffect, useMemo, useRef, useState } from 'react'
import { documentCues, planNarration, type EuclidDoc } from '@euclid/dsl'

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
  muted: boolean
}

/**
 * Narration playback for the editor preview.
 *
 * Placement comes from `planNarration` in @euclid/dsl — the same function the
 * export's ffmpeg mux uses — so what you hear while scrubbing is what lands in
 * the file, including narration cut short at a scene boundary. This lives in
 * the browser shell, never in @euclid/engine: the sampler must stay a pure
 * function of (document, time), and audio is neither.
 */
export function NarrationTrack({ doc, time, playing, muted }: Props) {
  const placements = useMemo(() => planNarration(doc), [doc])
  const elements = useRef(new Map<string, HTMLAudioElement>())
  const [blocked, setBlocked] = useState(false)

  useEffect(() => {
    for (const p of placements) {
      const el = elements.current.get(p.assetId)
      if (!el) continue
      el.muted = muted

      const local = time - p.startSec
      // `playSec`, not `durationSec`: narration that outruns its scene is cut
      // here exactly as the export cuts it with atrim.
      const active = local >= 0 && local < p.playSec

      if (!active) {
        if (!el.paused) el.pause()
        continue
      }
      if (!playing) {
        if (!el.paused) el.pause()
        // Scrubbing: keep the element parked at the playhead so pressing play
        // resumes from where the canvas already is.
        if (Math.abs(el.currentTime - local) > 0.05) el.currentTime = local
        continue
      }
      if (Math.abs(el.currentTime - local) > MAX_DRIFT_SEC) el.currentTime = local
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
  }, [time, playing, muted, placements])

  return (
    <>
      {placements.map((p) => (
        <audio
          key={p.assetId}
          ref={(el) => {
            if (el) elements.current.set(p.assetId, el)
            else elements.current.delete(p.assetId)
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

/**
 * Subtitles over the canvas, from the same `documentCues` the SRT/VTT export
 * serves. Cues are already clamped to their scene, so this shows exactly what
 * a viewer of the exported file would see.
 */
export function CaptionOverlay({ doc, time }: { doc: EuclidDoc; time: number }) {
  const cues = useMemo(() => documentCues(doc), [doc])
  const cue = cues.find((c) => time >= c.start && time < c.end)
  if (!cue) return null
  return (
    <div className={`caption-overlay${cue.estimated ? ' estimated' : ''}`}>
      <span>{cue.text}</span>
    </div>
  )
}
