import { useEffect, useMemo, useRef, useState } from 'react'
import {
  docDuration,
  keyMoments,
  op,
  planAudio,
  NARRATION_TRACK_ID,
  type AudioClip,
  type AudioPlacement,
  type AudioTrack,
  type EuclidDoc,
  type Op,
} from '@euclid/dsl'

/** Payload the explorer puts on a drag, so a lane can accept a file. */
export const AUDIO_DND_TYPE = 'application/x-euclid-audio'

interface Props {
  doc: EuclidDoc
  time: number
  playing: boolean
  muted: boolean
  captions: boolean
  solo: string | null
  onSolo: (trackId: string | null) => void
  onSeek: (t: number) => void
  onTogglePlay: () => void
  onToggleMute: () => void
  onToggleCaptions: () => void
  submit: (ops: Op[]) => void
}

/** Ruler steps, in seconds — the first one that leaves ≥64px between ticks wins. */
const TICKS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]
/** How close a dragged edge must come to a landmark before it clicks onto it. */
const SNAP_PX = 7
const ZOOMS = [1, 2, 4, 8]
/** A clip cannot be trimmed shorter than this — below it there is nothing to grab. */
const MIN_CLIP_SEC = 0.1

/** What a drag is doing to a clip, and what it looked like before it started. */
interface Drag {
  mode: 'move' | 'trim-start' | 'trim-end'
  trackId: string
  clipId: string
  grabX: number
  origin: AudioClip
  /** Live values while the pointer is down; committed as one op on release. */
  startSec: number
  sourceInSec: number
  playSec: number
  /** Lane the pointer is currently over — a move can change lanes. */
  toTrackId: string
}

export function Timeline({
  doc,
  time,
  playing,
  muted,
  captions,
  solo,
  onSolo,
  onSeek,
  onTogglePlay,
  onToggleMute,
  onToggleCaptions,
  submit,
}: Props) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<{ trackId: string; clipId: string } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dropLane, setDropLane] = useState<string | null>(null)

  const total = docDuration(doc)
  const tracks = doc.audio ?? []
  // Pure functions of the document, so these cost nothing to recompute and can
  // never disagree with what the agent's contact sheet or the export shows.
  const moments = useMemo(() => keyMoments(doc, { max: 24 }), [doc])
  const placements = useMemo(() => planAudio(doc), [doc])
  const narration = placements.filter((p) => p.trackId === NARRATION_TRACK_ID)

  const pct = (sec: number) => (total > 0 ? `${(sec / total) * 100}%` : '0%')
  const secPerPx = () => {
    const w = lanesRef.current?.getBoundingClientRect().width ?? 1
    return total / Math.max(1, w)
  }

  /** Times a dragged edge should click onto: the ends, every cut, every clip edge. */
  const snapTimes = useMemo(() => {
    const times = [0, total]
    let at = 0
    for (const scene of doc.scenes) {
      at += scene.duration
      times.push(at)
    }
    for (const p of placements) times.push(p.startSec, p.startSec + p.playSec)
    return times
  }, [doc, placements, total])

  const snap = (t: number, exclude?: string) => {
    const tol = SNAP_PX * secPerPx()
    let best = t
    let bestGap = tol
    for (const s of snapTimes) {
      const gap = Math.abs(s - t)
      if (gap < bestGap) {
        bestGap = gap
        best = s
      }
    }
    return exclude ? best : best
  }

  const seekFromEvent = (e: React.PointerEvent) => {
    const lanes = lanesRef.current
    if (!lanes || total === 0) return
    const rect = lanes.getBoundingClientRect()
    onSeek(Math.min(total, Math.max(0, ((e.clientX - rect.left) / rect.width) * total)))
  }

  // ---------- clip dragging ----------

  const beginDrag = (
    e: React.PointerEvent,
    track: AudioTrack,
    clip: AudioClip,
    mode: Drag['mode'],
  ) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setSelected({ trackId: track.id, clipId: clip.id })
    setDrag({
      mode,
      trackId: track.id,
      clipId: clip.id,
      grabX: e.clientX,
      origin: clip,
      startSec: clip.startSec,
      sourceInSec: clip.sourceInSec ?? 0,
      playSec: Math.min(clip.playSec ?? clip.durationSec, clip.durationSec - (clip.sourceInSec ?? 0)),
      toTrackId: track.id,
    })
  }

  const onDragMove = (e: React.PointerEvent) => {
    if (!drag) return
    const dt = (e.clientX - drag.grabX) * secPerPx()
    const origIn = drag.origin.sourceInSec ?? 0
    const origPlay = Math.min(
      drag.origin.playSec ?? drag.origin.durationSec,
      drag.origin.durationSec - origIn,
    )

    if (drag.mode === 'move') {
      const start = Math.max(0, Math.min(snap(drag.origin.startSec + dt), total - 0.05))
      // Which lane is the pointer over? A move can cross lanes, which is how a
      // clip gets from the effects lane to the music bed.
      const lane = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest('[data-track-id]')
        ?.getAttribute('data-track-id')
      const toTrackId = lane && lane !== NARRATION_TRACK_ID ? lane : drag.trackId
      setDrag({ ...drag, startSec: start, toTrackId })
      return
    }
    if (drag.mode === 'trim-end') {
      const end = snap(drag.origin.startSec + origPlay + dt)
      const playSec = Math.max(
        MIN_CLIP_SEC,
        Math.min(end - drag.origin.startSec, drag.origin.durationSec - origIn),
      )
      setDrag({ ...drag, playSec })
      return
    }
    // trim-start moves the head *and* the source offset, so the audio under
    // the cursor stays put instead of sliding.
    const start = snap(drag.origin.startSec + dt)
    const delta = Math.max(-origIn, Math.min(start - drag.origin.startSec, origPlay - MIN_CLIP_SEC))
    setDrag({
      ...drag,
      startSec: drag.origin.startSec + delta,
      sourceInSec: origIn + delta,
      playSec: origPlay - delta,
    })
  }

  const endDrag = (e: React.PointerEvent) => {
    if (!drag) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    const { origin } = drag
    const moved =
      Math.abs(drag.startSec - origin.startSec) > 0.001 ||
      Math.abs(drag.sourceInSec - (origin.sourceInSec ?? 0)) > 0.001 ||
      Math.abs(drag.playSec - (origin.playSec ?? origin.durationSec)) > 0.001
    const changedLane = drag.toTrackId !== drag.trackId

    // One op per drag, on release — sending a patch per pointermove would put
    // sixty envelopes a second through the event log to describe one gesture.
    if (changedLane) {
      submit([
        op.moveAudioClip(drag.trackId, drag.toTrackId, drag.clipId, drag.startSec),
        op.updateAudioClip(drag.toTrackId, drag.clipId, {
          sourceInSec: drag.sourceInSec,
          playSec: drag.playSec,
        }),
      ])
      setSelected({ trackId: drag.toTrackId, clipId: drag.clipId })
    } else if (moved) {
      submit([
        op.updateAudioClip(drag.trackId, drag.clipId, {
          startSec: drag.startSec,
          sourceInSec: drag.sourceInSec,
          playSec: drag.playSec,
        }),
      ])
    }
    setDrag(null)
  }

  // Delete removes the selected clip — the one keyboard shortcut a timeline
  // needs, and useless without a visible selection, which is why clips select.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (!selected) return
      e.preventDefault()
      submit([op.removeAudioClip(selected.trackId, selected.clipId)])
      setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, submit])

  // ---------- dropping a file from the explorer ----------

  const dropAudio = async (e: React.DragEvent, track: AudioTrack) => {
    e.preventDefault()
    setDropLane(null)
    const raw = e.dataTransfer.getData(AUDIO_DND_TYPE)
    if (!raw) return
    const file = JSON.parse(raw) as { assetId: string; name: string; durationSec: number | null }
    const lanes = lanesRef.current
    if (!lanes) return
    const rect = lanes.getBoundingClientRect()
    const startSec = Math.max(0, Math.min(total, ((e.clientX - rect.left) / rect.width) * total))

    // An uploaded file often has no recorded duration — only the TTS producer
    // knows one at write time. Ask the browser rather than guessing: a clip
    // with the wrong length would draw wrong and trim wrong.
    const durationSec = file.durationSec ?? (await probeDuration(file.assetId))
    if (!durationSec) return
    submit([
      op.addAudioClip(track.id, {
        id: `clip_${Math.random().toString(36).slice(2, 10)}`,
        assetId: file.assetId,
        startSec: snap(startSec),
        durationSec,
        name: file.name,
      }),
    ])
  }

  const addTrack = () => {
    const n = tracks.length + 1
    submit([
      op.addAudioTrack({
        id: `track_${Math.random().toString(36).slice(2, 8)}`,
        name: n === 1 ? 'Music' : `Track ${n}`,
        kind: n === 1 ? 'music' : 'sfx',
        clips: [],
      }),
    ])
  }

  const step = TICKS.find((s) => (s / Math.max(total, 0.001)) * (zoom * 100) >= 6) ?? 60
  const ticks: number[] = []
  for (let t = 0; t <= total + 1e-6; t += step) ticks.push(Number(t.toFixed(3)))

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button onClick={onTogglePlay} title={playing ? 'pause' : 'play'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="time-readout">
          {time.toFixed(2)}s / {total.toFixed(2)}s
        </span>
        <button
          className={muted ? 'toggle off' : 'toggle'}
          onClick={onToggleMute}
          title={muted ? 'unmute' : 'mute everything'}
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
        <span className="grow" />
        {solo && (
          <button className="toggle solo-clear" onClick={() => onSolo(null)} title="stop soloing">
            solo on — clear
          </button>
        )}
        <span className="zoom">
          {ZOOMS.map((z) => (
            <button
              key={z}
              className={`toggle${zoom === z ? '' : ' off'}`}
              onClick={() => setZoom(z)}
              title={`${z}× zoom`}
            >
              {z}×
            </button>
          ))}
        </span>
        <button className="toggle" onClick={addTrack} title="add an audio track">
          + track
        </button>
      </div>

      <div className="tl">
        <div className="tl-heads">
          <div className="tl-head ruler-head" />
          <div className="tl-head">scenes</div>
          <div className="tl-head">
            <span className="lane-name">narration</span>
            <SoloButton id={NARRATION_TRACK_ID} solo={solo} onSolo={onSolo} />
          </div>
          {tracks.map((t) => (
            <TrackHead
              key={t.id}
              track={t}
              solo={solo}
              onSolo={onSolo}
              submit={submit}
            />
          ))}
        </div>

        {/* One scroller for every lane, so the ruler, the scenes and the audio
            can never disagree about where a second is. */}
        <div className="tl-scroll">
          <div
            className="tl-lanes"
            ref={lanesRef}
            style={{ width: `${zoom * 100}%` }}
            onPointerDown={(e) => {
              // Clicking empty timeline seeks; a clip stops this itself.
              ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
              setSelected(null)
              seekFromEvent(e)
            }}
            onPointerMove={(e) => {
              if (drag) return onDragMove(e)
              if (e.buttons & 1) seekFromEvent(e)
            }}
            onPointerUp={(e) => drag && endDrag(e)}
          >
            <div className="tl-ruler">
              {total > 0 &&
                ticks.map((t) => (
                  <span key={t} className="tick" style={{ left: pct(t) }}>
                    {formatTick(t, step)}
                  </span>
                ))}
            </div>

            <div className="tl-lane lane-scenes">
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
              {/* The same moments `preview_frames` captures, from the same pure
                  function — so the human and the agent look at one list rather
                  than two. Clicking one seeks there. */}
              {total > 0 &&
                moments.map((m) => (
                  <button
                    key={`${m.kind}-${m.t}`}
                    type="button"
                    className={`moment moment-${m.kind}`}
                    style={{ left: pct(m.t) }}
                    title={`${m.t.toFixed(2)}s — ${m.kind} ${m.label}`}
                    aria-label={`seek to ${m.t.toFixed(2)} seconds, ${m.kind}`}
                    onPointerDown={(e) => {
                      e.stopPropagation()
                      onSeek(m.t)
                    }}
                  />
                ))}
            </div>

            {/* Narration is generated, scene-scoped and read-only here: moving
                it would decouple a line from the shot it explains. */}
            <div className="tl-lane lane-audio" data-track-id={NARRATION_TRACK_ID}>
              {narration.length === 0 && <span className="lane-empty">no narration</span>}
              {narration.map((p) => (
                <div
                  key={p.key}
                  className={`audio-clip narration-clip${p.playSec < p.durationSec - 0.001 ? ' trimmed' : ''}`}
                  style={{ left: pct(p.startSec), width: pct(p.playSec) }}
                  title={clipTitle(p)}
                >
                  <span>🔊 {p.playSec.toFixed(1)}s</span>
                </div>
              ))}
            </div>

            {tracks.map((track) => (
              <div
                key={track.id}
                className={`tl-lane lane-audio${dropLane === track.id ? ' drop-target' : ''}${
                  track.muted ? ' lane-muted' : ''
                }`}
                data-track-id={track.id}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(AUDIO_DND_TYPE)) return
                  e.preventDefault()
                  setDropLane(track.id)
                }}
                onDragLeave={() => setDropLane((l) => (l === track.id ? null : l))}
                onDrop={(e) => void dropAudio(e, track)}
              >
                {track.clips.length === 0 && (
                  <span className="lane-empty">drag an audio file here</span>
                )}
                {track.clips.map((clip) => {
                  const live = drag?.clipId === clip.id ? drag : null
                  const startSec = live ? live.startSec : clip.startSec
                  const playSec = live
                    ? live.playSec
                    : Math.min(
                        clip.playSec ?? clip.durationSec,
                        clip.durationSec - (clip.sourceInSec ?? 0),
                      )
                  const isSelected =
                    selected?.clipId === clip.id && selected.trackId === track.id
                  const ghost = live && live.toTrackId !== track.id
                  return (
                    <div
                      key={clip.id}
                      className={`audio-clip track-clip${isSelected ? ' selected' : ''}${
                        ghost ? ' ghost' : ''
                      }`}
                      style={{ left: pct(startSec), width: pct(playSec) }}
                      title={`${clip.name ?? track.name} — ${startSec.toFixed(2)}s → ${(
                        startSec + playSec
                      ).toFixed(2)}s`}
                      onPointerDown={(e) => beginDrag(e, track, clip, 'move')}
                      onPointerMove={onDragMove}
                      onPointerUp={endDrag}
                    >
                      <span
                        className="clip-handle handle-start"
                        onPointerDown={(e) => beginDrag(e, track, clip, 'trim-start')}
                        onPointerMove={onDragMove}
                        onPointerUp={endDrag}
                      />
                      <span className="clip-label">{clip.name ?? track.name}</span>
                      <FadeMarks clip={clip} playSec={playSec} />
                      <span
                        className="clip-handle handle-end"
                        onPointerDown={(e) => beginDrag(e, track, clip, 'trim-end')}
                        onPointerMove={onDragMove}
                        onPointerUp={endDrag}
                      />
                    </div>
                  )
                })}
              </div>
            ))}

            {total > 0 && <div className="playhead" style={{ left: pct(Math.min(time, total)) }} />}
          </div>
        </div>
      </div>

      {selected && <ClipInspector doc={doc} selected={selected} submit={submit} />}
    </div>
  )
}

/** Fade ramps drawn on the clip, so a fade is visible without opening anything. */
function FadeMarks({ clip, playSec }: { clip: AudioClip; playSec: number }) {
  const fin = Math.min(clip.fadeInSec ?? 0, playSec)
  const fout = Math.min(clip.fadeOutSec ?? 0, playSec)
  if (!fin && !fout) return null
  return (
    <>
      {fin > 0 && <span className="fade fade-in" style={{ width: `${(fin / playSec) * 100}%` }} />}
      {fout > 0 && <span className="fade fade-out" style={{ width: `${(fout / playSec) * 100}%` }} />}
    </>
  )
}

function SoloButton({
  id,
  solo,
  onSolo,
}: {
  id: string
  solo: string | null
  onSolo: (t: string | null) => void
}) {
  return (
    <button
      className={`lane-btn${solo === id ? ' on' : ''}`}
      title="solo (editor only — never exported)"
      onClick={() => onSolo(solo === id ? null : id)}
    >
      S
    </button>
  )
}

function TrackHead({
  track,
  solo,
  onSolo,
  submit,
}: {
  track: AudioTrack
  solo: string | null
  onSolo: (t: string | null) => void
  submit: (ops: Op[]) => void
}) {
  return (
    <div className={`tl-head${track.muted ? ' muted' : ''}`}>
      <span
        className="lane-name"
        title={`${track.kind} — double-click to rename`}
        onDoubleClick={() => {
          const name = window.prompt('Track name', track.name)
          if (name) submit([op.updateAudioTrack(track.id, { name })])
        }}
      >
        {track.name}
      </span>
      {/* Mute is in the document because it changes the export; solo is not. */}
      <button
        className={`lane-btn${track.muted ? ' on' : ''}`}
        title={track.muted ? 'unmute (affects the export)' : 'mute (affects the export)'}
        onClick={() => submit([op.updateAudioTrack(track.id, { muted: !track.muted })])}
      >
        M
      </button>
      <SoloButton id={track.id} solo={solo} onSolo={onSolo} />
      <input
        className="lane-gain"
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={track.gain ?? 1}
        title={`gain ${Math.round((track.gain ?? 1) * 100)}%`}
        onChange={(e) => submit([op.updateAudioTrack(track.id, { gain: Number(e.target.value) })])}
      />
      <button
        className="lane-btn"
        title="remove this track and its clips"
        onClick={() => {
          if (window.confirm(`Remove "${track.name}" and its ${track.clips.length} clip(s)?`)) {
            submit([op.removeAudioTrack(track.id)])
          }
        }}
      >
        ✕
      </button>
    </div>
  )
}

/** The numbers a drag cannot express: exact gain, and the two fade lengths. */
function ClipInspector({
  doc,
  selected,
  submit,
}: {
  doc: EuclidDoc
  selected: { trackId: string; clipId: string }
  submit: (ops: Op[]) => void
}) {
  const track = doc.audio?.find((t) => t.id === selected.trackId)
  const clip = track?.clips.find((c) => c.id === selected.clipId)
  if (!track || !clip) return null
  const patch = (p: Partial<AudioClip>) => submit([op.updateAudioClip(track.id, clip.id, p)])
  const playSec = Math.min(clip.playSec ?? clip.durationSec, clip.durationSec - (clip.sourceInSec ?? 0))

  return (
    <div className="clip-inspector">
      <span className="clip-title">{clip.name ?? track.name}</span>
      <span className="muted">
        {clip.startSec.toFixed(2)}s → {(clip.startSec + playSec).toFixed(2)}s of{' '}
        {clip.durationSec.toFixed(2)}s
      </span>
      <label>
        gain
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={clip.gain ?? 1}
          onChange={(e) => patch({ gain: Number(e.target.value) })}
        />
        <span className="num">{Math.round((clip.gain ?? 1) * 100)}%</span>
      </label>
      <label>
        fade in
        <input
          type="number"
          min={0}
          step={0.25}
          value={clip.fadeInSec ?? 0}
          onChange={(e) => patch({ fadeInSec: Math.max(0, Number(e.target.value)) })}
        />
      </label>
      <label>
        fade out
        <input
          type="number"
          min={0}
          step={0.25}
          value={clip.fadeOutSec ?? 0}
          onChange={(e) => patch({ fadeOutSec: Math.max(0, Number(e.target.value)) })}
        />
      </label>
      <button className="toggle" onClick={() => submit([op.removeAudioClip(track.id, clip.id)])}>
        remove clip
      </button>
    </div>
  )
}

function clipTitle(p: AudioPlacement): string {
  const cut = p.playSec < p.durationSec - 0.001
  return (
    `${p.label} ${p.startSec.toFixed(2)}s → ${(p.startSec + p.playSec).toFixed(2)}s` +
    (cut ? ` (cut ${(p.durationSec - p.playSec).toFixed(2)}s at the scene edge)` : '')
  )
}

/** Sub-second steps need decimals; minute-long ones read better as m:ss. */
function formatTick(t: number, step: number): string {
  if (step < 1) return `${t.toFixed(2)}`
  if (t >= 60) return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`
  return `${t}s`
}

/**
 * Ask the browser how long an asset is. Only producers record `durationSec`,
 * so a file the user uploaded arrives without one — and a clip drawn from a
 * guessed length would trim at the wrong place.
 */
function probeDuration(assetId: string): Promise<number | null> {
  const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'
  return new Promise((resolve) => {
    const el = new Audio(`${API}/api/assets/${assetId}`)
    el.crossOrigin = 'use-credentials'
    el.preload = 'metadata'
    el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : null)
    el.onerror = () => resolve(null)
  })
}
