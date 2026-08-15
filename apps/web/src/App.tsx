import { useEffect, useRef, useState } from 'react'
import { assetIdsInDoc, docDuration, globalToScene } from '@euclid/dsl'
import { useProject } from './useProject'
import { Preview } from './Preview'
import { Timeline } from './Timeline'
import { Inspector } from './Inspector'
import { Assets } from './Assets'
import { CaptionOverlay, NarrationTrack } from './Narration'
import { ProjectList } from './ProjectList'

/**
 * Routing, such as it is: `?project=<id>` opens the editor on that project,
 * `?demo=1` opens the offline demo, and bare `/` lists the projects. The
 * split into two components is structural, not stylistic — hooks can't be
 * called conditionally, so the editor's state can't live behind an early
 * return.
 */
export function App() {
  const params = new URLSearchParams(window.location.search)
  const projectId = params.get('project')
  if (!projectId && !params.has('demo')) return <ProjectList />
  return <Editor projectId={projectId} />
}

function Editor({ projectId }: { projectId: string | null }) {
  // `decisions`/`answerDecision` are intentionally not consumed here: the
  // questions panel was removed from the side panel. The loop still works —
  // questions ride the DO and are answered in chat via record_answer.
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
        <a className="back" href="?" title="all projects">
          ← <h1>Euclid</h1>
        </a>
        <span className="project-name">{doc.name}</span>
        {offline && <span className="badge offline">offline demo — not a real project</span>}
        {error && <span className="badge error">{error}</span>}
      </header>
      <main>
        <div className="stage">
          <Preview doc={doc} time={time} />
          {captions && <CaptionOverlay doc={doc} time={time} playing={playing} />}
        </div>
        <div className="side">
          {/* Reload when the document's asset references change — that is what a
              new narration clip looks like from here. */}
          {projectId && (
            <Assets projectId={projectId} reloadKey={[...assetIdsInDoc(doc)].sort().join(',')} />
          )}
          <Inspector
            doc={doc}
            currentScene={at?.scene ?? null}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
            submit={submit}
          />
        </div>
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
