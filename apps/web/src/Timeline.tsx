import { useMemo, useRef } from 'react'
import { docDuration, planNarration, type EuclidDoc } from '@euclid/dsl'

interface Props {
  doc: EuclidDoc
  time: number
  playing: boolean
  muted: boolean
  captions: boolean
  onSeek: (t: number) => void
  onTogglePlay: () => void
  onToggleMute: () => void
  onToggleCaptions: () => void
}

export function Timeline({
  doc,
  time,
  playing,
  muted,
  captions,
  onSeek,
  onTogglePlay,
  onToggleMute,
  onToggleCaptions,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null)
  const total = docDuration(doc)
  // Same placement the export's ffmpeg mux uses, so the lane shows where audio
  // actually lands in the file — including narration trimmed at a scene edge.
  // The gaps between blocks are the silence `get_project` reports as tail.
  const narration = useMemo(() => planNarration(doc), [doc])

  const seekFromEvent = (e: React.PointerEvent) => {
    const bar = barRef.current
    if (!bar || total === 0) return
    const rect = bar.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    onSeek(frac * total)
  }

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button onClick={onTogglePlay}>{playing ? '⏸' : '▶'}</button>
        <span className="time-readout">
          {time.toFixed(2)}s / {total.toFixed(2)}s
        </span>
        <button
          className={muted ? 'toggle off' : 'toggle'}
          onClick={onToggleMute}
          title={muted ? 'unmute narration' : 'mute narration'}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button
          className={captions ? 'toggle' : 'toggle off'}
          onClick={onToggleCaptions}
          title={captions ? 'hide captions' : 'show captions'}
        >
          CC
        </button>
      </div>
      <div
        ref={barRef}
        className="timeline-bar"
        onPointerDown={(e) => {
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          seekFromEvent(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) seekFromEvent(e)
        }}
      >
        {doc.scenes.map((sc) => (
          <div
            key={sc.id}
            className="timeline-scene"
            style={{ width: total > 0 ? `${(sc.duration / total) * 100}%` : '0%' }}
            title={`${sc.name} (${sc.duration}s)`}
          >
            <span>{sc.name}</span>
            {sc.narration && <span className="narration-dot" title="has narration">●</span>}
          </div>
        ))}
        {total > 0 && (
          <div className="playhead" style={{ left: `${(Math.min(time, total) / total) * 100}%` }} />
        )}
      </div>

      {/* Audio lane. Shares the bar's coordinate space, so a clip sits directly
          under the scene it speaks over and the silence is visible as a gap. */}
      <div className="timeline-audio" aria-label="narration track">
        {narration.length === 0 && <span className="lane-empty">no narration</span>}
        {total > 0 &&
          narration.map((p) => {
            const trimmed = p.playSec < p.durationSec - 0.001
            return (
              <div
                key={p.assetId}
                className={`audio-clip${trimmed ? ' trimmed' : ''}`}
                style={{
                  left: `${(p.startSec / total) * 100}%`,
                  width: `${(p.playSec / total) * 100}%`,
                }}
                title={
                  `narration ${p.startSec.toFixed(2)}s → ${(p.startSec + p.playSec).toFixed(2)}s` +
                  (trimmed ? ` (cut ${(p.durationSec - p.playSec).toFixed(2)}s at the scene edge)` : '')
                }
              >
                <span>🔊 {p.playSec.toFixed(1)}s</span>
              </div>
            )
          })}
        {total > 0 && (
          <div className="playhead" style={{ left: `${(Math.min(time, total) / total) * 100}%` }} />
        )}
      </div>
    </div>
  )
}
