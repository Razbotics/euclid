import { useEffect, useRef, useState } from 'react'
import { assetBasename, assetIdsInDoc, docDuration, globalToScene } from '@euclid/dsl'
import { useProject } from './useProject'
import { useAssets, type ProjectFile } from './useAssets'
import { Preview } from './Preview'
import { Timeline } from './Timeline'
import { Inspector } from './Inspector'
import { Assets } from './Assets'
import { FileViewer, fileGlyph } from './FileViewer'
import { CameraFrame } from './Camera'
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

/** Which panels are open, and how wide. Remembered, because a layout you
 *  re-set every reload is not a layout. */
interface Panels {
  left: boolean
  right: boolean
  leftWidth: number
  rightWidth: number
}
const PANELS_KEY = 'euclid.panels'
const DEFAULT_PANELS: Panels = { left: true, right: true, leftWidth: 260, rightWidth: 320 }

/** A panel narrower than this is a rail with extra steps; the canvas needs at
 *  least this much to still be the thing you are working on. */
const MIN_PANEL = 170
const MIN_EDITOR = 360

function loadPanels(): Panels {
  try {
    const raw = window.localStorage.getItem(PANELS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Panels>
      return {
        left: p.left !== false,
        right: p.right !== false,
        // A stored width from a wider window is clamped on the first layout
        // pass, not trusted — see the resize effect.
        leftWidth: Number(p.leftWidth) || DEFAULT_PANELS.leftWidth,
        rightWidth: Number(p.rightWidth) || DEFAULT_PANELS.rightWidth,
      }
    }
  } catch {
    // A corrupt preference is not worth a broken editor.
  }
  return DEFAULT_PANELS
}

function savePanels(p: Panels) {
  try {
    window.localStorage.setItem(PANELS_KEY, JSON.stringify(p))
  } catch {
    // Private-mode storage failure must not swallow the change.
  }
}

/**
 * A drag can never squeeze the editor out of existence: the panel being sized
 * is bounded by what the *other* panel and a usable canvas already claim, so
 * the three columns always add up to something you can work in.
 */
function clampPanels(p: Panels): Panels {
  const room = (occupiedBy: number) =>
    Math.max(MIN_PANEL, window.innerWidth - occupiedBy - MIN_EDITOR)
  const rightNow = p.right ? p.rightWidth : 0
  const leftWidth = Math.max(MIN_PANEL, Math.min(p.leftWidth, room(rightNow)))
  const leftNow = p.left ? leftWidth : 0
  const rightWidth = Math.max(MIN_PANEL, Math.min(p.rightWidth, room(leftNow)))
  return leftWidth === p.leftWidth && rightWidth === p.rightWidth
    ? p
    : { ...p, leftWidth, rightWidth }
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
  const [panels, setPanels] = useState<Panels>(loadPanels)
  /** True mid-drag, so the whole app can stop selecting text under the cursor. */
  const [resizing, setResizing] = useState(false)

  // Reload the file list when the document's asset references change — that is
  // what a new narration clip looks like from here.
  const assets = useAssets(projectId, doc ? [...assetIdsInDoc(doc)].sort().join(',') : '')

  // The editor column is a tab strip: the canvas is tab zero and never closes,
  // and every opened file is a tab beside it, VS Code style.
  const [openIds, setOpenIds] = useState<string[]>([])
  const [activeTab, setActiveTab] = useState<string>('canvas')
  const openFiles = openIds
    .map((id) => assets.files?.find((f) => f.id === id))
    .filter((f): f is ProjectFile => !!f)

  // A file deleted from the tree (or by an agent, over the same list) takes its
  // tab with it — a tab pointing at a 404 is worse than no tab.
  useEffect(() => {
    if (!assets.files) return
    const alive = new Set(assets.files.map((f) => f.id))
    setOpenIds((ids) => (ids.every((id) => alive.has(id)) ? ids : ids.filter((id) => alive.has(id))))
  }, [assets.files])
  useEffect(() => {
    if (activeTab !== 'canvas' && !openIds.includes(activeTab)) setActiveTab('canvas')
  }, [openIds, activeTab])

  const togglePanel = (side: 'left' | 'right') =>
    setPanels((p) => {
      // Reopening never restores a width that no longer fits — the window may
      // have shrunk while the panel was a rail.
      const next = clampPanels({ ...p, [side]: !p[side] })
      savePanels(next)
      return next
    })

  /** Live during a drag; the preference is written once, when you let go. */
  const resize = (side: 'left' | 'right', width: number) =>
    setPanels((p) => clampPanels({ ...p, [side === 'left' ? 'leftWidth' : 'rightWidth']: width }))

  /** Double-clicking the handle puts the panel back to its shipped width. */
  const resetWidth = (side: 'left' | 'right') => {
    const key = side === 'left' ? 'leftWidth' : 'rightWidth'
    const next = clampPanels({ ...panels, [key]: DEFAULT_PANELS[key] })
    setPanels(next)
    savePanels(next)
  }

  // A window narrow enough would otherwise leave the two fixed-width panels
  // holding the whole viewport and the canvas at zero.
  useEffect(() => {
    const onResize = () => setPanels((p) => clampPanels(p))
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // VS Code's own bindings: ⌘B for the primary sidebar, ⌘⌥B for the secondary.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      togglePanel(e.altKey ? 'right' : 'left')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Opening the sixth file must not put its tab off the end of the strip.
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    stripRef.current?.querySelector('.tab.active')?.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
    })
  }, [activeTab, openIds])

  const openFile = (file: ProjectFile) => {
    setOpenIds((ids) => (ids.includes(file.id) ? ids : [...ids, file.id]))
    setActiveTab(file.id)
  }

  const closeTab = (id: string) => {
    const i = openIds.indexOf(id)
    const next = openIds.filter((x) => x !== id)
    setOpenIds(next)
    // Focus the neighbour the way an editor does, not always the canvas.
    if (activeTab === id) setActiveTab(next[Math.min(i, next.length - 1)] ?? 'canvas')
  }

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
  const activeFile = openFiles.find((f) => f.id === activeTab) ?? null

  return (
    <div className={`app${resizing ? ' resizing' : ''}`}>
      <header>
        <a className="back" href="?" title="all projects">
          ← <h1>Euclid</h1>
        </a>
        <span className="project-name">{doc.name}</span>
        {offline && <span className="badge offline">offline demo — not a real project</span>}
        {error && <span className="badge error">{error}</span>}
        <span className="grow" />
        <button
          className={`icon-btn${panels.left ? ' on' : ''}`}
          onClick={() => togglePanel('left')}
          title="files (⌘B)"
        >
          ▤ files
        </button>
        <button
          className={`icon-btn${panels.right ? ' on' : ''}`}
          onClick={() => togglePanel('right')}
          title="scene inspector (⌘⌥B)"
        >
          scene ▥
        </button>
      </header>

      <main className="workbench">
        {panels.left ? (
          <aside className="panel panel-left" style={{ width: panels.leftWidth }}>
            <div className="panel-head">
              <span>explorer</span>
              <span className="count">{assets.files?.length ?? ''}</span>
              <span className="grow" />
              <button className="icon-btn" onClick={() => void assets.reload()} title="refresh">
                ⟳
              </button>
              <button className="icon-btn" onClick={() => togglePanel('left')} title="collapse">
                ⟨
              </button>
            </div>
            <div className="panel-body">
              <Assets state={assets} activeId={activeTab} onOpen={openFile} offline={offline} />
            </div>
          </aside>
        ) : (
          <Rail side="left" label="explorer" onClick={() => togglePanel('left')} />
        )}
        {panels.left && (
          <Splitter
            side="left"
            width={panels.leftWidth}
            onResize={(w) => resize('left', w)}
            onReset={() => resetWidth('left')}
            onCommit={() => savePanels(panels)}
            onDragging={setResizing}
          />
        )}

        <section className="editor">
          <div className="tabstrip" ref={stripRef}>
            <button
              className={`tab tab-canvas${activeTab === 'canvas' ? ' active' : ''}`}
              onClick={() => setActiveTab('canvas')}
            >
              <span className="tab-glyph">◉</span> canvas
            </button>
            {openFiles.map((f) => (
              <span key={f.id} className={`tab${activeTab === f.id ? ' active' : ''}`}>
                <button className="tab-open" onClick={() => setActiveTab(f.id)} title={f.path}>
                  <span className="tab-glyph">{fileGlyph(f)}</span> {assetBasename(f.path)}
                </button>
                <button className="tab-close" onClick={() => closeTab(f.id)} title="close">
                  ✕
                </button>
              </span>
            ))}
          </div>

          <div className="editor-body">
            {/* The canvas is hidden, never unmounted: Pixi's app and its ticker
                are expensive to rebuild, and tearing one down to read a text
                file would restart the preview every time you glance at one. */}
            <div className="stage" style={{ display: activeTab === 'canvas' ? 'flex' : 'none' }}>
              <Preview doc={doc} time={time} />
              {/* Only appears for a scene that has a camera — otherwise the
                  frame is the canvas and there is nothing to say. */}
              <CameraFrame doc={doc} time={time} />
              {captions && <CaptionOverlay doc={doc} time={time} playing={playing} />}
            </div>
            {activeFile && <FileViewer key={activeFile.id} file={activeFile} />}
          </div>
        </section>

        {panels.right && (
          <Splitter
            side="right"
            width={panels.rightWidth}
            onResize={(w) => resize('right', w)}
            onReset={() => resetWidth('right')}
            onCommit={() => savePanels(panels)}
            onDragging={setResizing}
          />
        )}
        {panels.right ? (
          <aside className="panel panel-right" style={{ width: panels.rightWidth }}>
            <div className="panel-head">
              <span>scene</span>
              <span className="grow" />
              <button className="icon-btn" onClick={() => togglePanel('right')} title="collapse">
                ⟩
              </button>
            </div>
            <div className="panel-body">
              <Inspector
                doc={doc}
                currentScene={at?.scene ?? null}
                selectedNodeId={selectedNodeId}
                onSelect={setSelectedNodeId}
                submit={submit}
              />
            </div>
          </aside>
        ) : (
          <Rail side="right" label="scene" onClick={() => togglePanel('right')} />
        )}
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

/**
 * The drag handle between a panel and the editor.
 *
 * Pointer capture rather than window listeners: the pointer keeps reporting to
 * this element once the drag starts, so a fast drag that outruns the cursor —
 * or crosses the `<canvas>`, an `<iframe>` PDF, or a `<video>`, all of which
 * happily swallow mouse events — still resizes instead of stopping dead.
 *
 * The width is recomputed from where the drag *started*, never accumulated
 * from each move, so a clamp at the limit cannot drift the handle away from
 * the cursor.
 */
function Splitter({
  side,
  width,
  onResize,
  onReset,
  onCommit,
  onDragging,
}: {
  side: 'left' | 'right'
  width: number
  onResize: (width: number) => void
  onReset: () => void
  onCommit: () => void
  onDragging: (dragging: boolean) => void
}) {
  const from = useRef<{ x: number; width: number } | null>(null)

  return (
    <div
      className={`splitter splitter-${side}`}
      role="separator"
      aria-orientation="vertical"
      title="drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        from.current = { x: e.clientX, width }
        onDragging(true)
      }}
      onPointerMove={(e) => {
        const start = from.current
        if (!start) return
        const dx = e.clientX - start.x
        onResize(start.width + (side === 'left' ? dx : -dx))
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId)
        from.current = null
        onDragging(false)
        onCommit()
      }}
      onPointerCancel={() => {
        from.current = null
        onDragging(false)
        onCommit()
      }}
      onDoubleClick={onReset}
    />
  )
}

/** What a collapsed panel leaves behind: a strip you can click to get it back. */
function Rail({
  side,
  label,
  onClick,
}: {
  side: 'left' | 'right'
  label: string
  onClick: () => void
}) {
  return (
    <button className={`rail rail-${side}`} onClick={onClick} title={`show ${label}`}>
      {label}
    </button>
  )
}
