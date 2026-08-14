import { useEffect, useRef, useState } from 'react'
import { docDuration, globalToScene } from '@euclid/dsl'
import { useProject } from './useProject'
import { Preview } from './Preview'
import { Timeline } from './Timeline'
import { Inspector } from './Inspector'
import { CaptionOverlay, NarrationTrack } from './Narration'

export function App() {
  const projectId = new URLSearchParams(window.location.search).get('project')
  const { doc, offline, error, submit } = useProject(projectId)

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [captions, setCaptions] = useState(true)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

  // Playback clock: rAF accumulates into `time`; rendering itself stays a pure
  // function of (doc, time), so scrubbing and playing are the same operation.
  const playingRef = useRef(playing)
  playingRef.current = playing
  useEffect(() => {
    if (!playing || !doc) return
    let raf = 0
    let last = performance.now()
    const total = docDuration(doc)
    const tick = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setTime((t) => {
        const nt = t + dt
        if (nt >= total) {
          setPlaying(false)
          return total
        }
        return nt
      })
      if (playingRef.current) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, doc])

  if (!doc) {
    return <div className="loading">{error ?? 'loading project…'}</div>
  }

  const at = globalToScene(doc, time)

  return (
    <div className="app">
      <header>
        <h1>Euclid</h1>
        <span className="project-name">{doc.name}</span>
        {offline && <span className="badge offline">offline demo</span>}
        {error && <span className="badge error">{error}</span>}
      </header>
      <main>
        <div className="stage">
          <Preview doc={doc} time={time} />
          {captions && <CaptionOverlay doc={doc} time={time} />}
        </div>
        <Inspector
          doc={doc}
          currentScene={at?.scene ?? null}
          selectedNodeId={selectedNodeId}
          onSelect={setSelectedNodeId}
          submit={submit}
        />
      </main>
      <NarrationTrack doc={doc} time={time} playing={playing} muted={muted} />
      <Timeline
        doc={doc}
        time={time}
        playing={playing}
        muted={muted}
        captions={captions}
        onToggleMute={() => setMuted((m) => !m)}
        onToggleCaptions={() => setCaptions((c) => !c)}
        onSeek={(t) => {
          setPlaying(false)
          setTime(t)
        }}
        onTogglePlay={() => {
          if (!playing && time >= docDuration(doc)) setTime(0)
          setPlaying((p) => !p)
        }}
      />
    </div>
  )
}
