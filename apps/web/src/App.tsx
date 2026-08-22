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
import { CaptionOverlay } from './Narration'
import { AudioMixer } from './AudioMixer'
import { Review, ReviewModeToggle } from './Review'
import { Sidebar, useProjects, type ProjectsState } from './Sidebar'

/**
 * Routing, such as it is: `?project=<id>` opens the editor on that project,
 * `?demo=1` opens the offline demo, and bare `/` auto-opens the newest
 * project — there is no listing page any more; the sidebar's flyout is the
 * list. The split into two components is structural, not stylistic — hooks
 * can't be called conditionally, so the editor's state can't live behind an
 * early return.
 */
export function App() {
  const params = new URLSearchParams(window.location.search)
  const projectId = params.get('project')
  const demo = params.has('demo')
  const projects = useProjects()

  // Landing on bare `/` means "my latest work", the way an editor reopens
  // what you had open. `replace` rather than push, so Back does not bounce
  // through the redirect.
  useEffect(() => {
    if (projectId || demo) return
    const newest = projects.status === 'ready' ? projects.projects[0] : undefined
    if (newest) window.location.replace(`?project=${newest.id}`)
  }, [projectId, demo, projects])

  if (!projectId && !demo) return <Landing projects={projects} />
  return <Editor projectId={projectId} projects={projects} />
}

/** Bare `/` with nothing to open yet: the shell, and a hint in the middle. */
function Landing({ projects }: { projects: ProjectsState }) {
  return (
    <div className="app">
      <div className="shell">
        <Sidebar projects={projects} currentId={null} offline={false} />
        <div className="landing">
          {projects.status === 'loading' && <p>loading projects…</p>}
          {projects.status === 'error' && (
            <p>
              {projects.message} — start it with <code>pnpm dev:api</code>, or{' '}
              <a href="?demo=1">open the offline demo</a>.
            </p>
          )}
          {projects.status === 'ready' && (
            <p>
              No projects yet. An agent creates them over MCP with <code>create_project</code>,
              or <a href="?demo=1">open the offline demo</a>.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The right side is a stack of optional panels, Claude Code style: closed by
 * default, each toggled from the header's ⋯ menu, stacking vertically in the
 * order opened. Which are open — and how wide the stack is — is remembered.
 */
type PanelId = 'files' | 'scene' | 'review'
const PANEL_TITLES: Record<PanelId, string> = {
  files: 'Files',
  scene: 'Scene',
  review: 'Review',
}

interface Panels {
  open: PanelId[]
  rightWidth: number
}
const PANELS_KEY = 'euclid.panels.v2'
const DEFAULT_PANELS: Panels = { open: [], rightWidth: 340 }

/** The stack narrower than this is unusable; the canvas needs at least this
 *  much to still be the thing you are working on. The sidebar rail is fixed. */
const MIN_STACK = 220
const MIN_EDITOR = 360
const RAIL_WIDTH = 46

function loadPanels(): Panels {
  try {
    const raw = window.localStorage.getItem(PANELS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Panels>
      const valid = (x: unknown): x is PanelId =>
        x === 'files' || x === 'scene' || x === 'review'
      return {
        open: Array.isArray(p.open) ? p.open.filter(valid) : [],
        // A stored width from a wider window is clamped on the first layout
        // pass, not trusted — see the resize effect.
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

/** A drag can never squeeze the editor out of existence: the stack is bounded
 *  by what the rail and a usable canvas already claim. */
function clampPanels(p: Panels): Panels {
  const max = Math.max(MIN_STACK, window.innerWidth - RAIL_WIDTH - MIN_EDITOR)
  const rightWidth = Math.max(MIN_STACK, Math.min(p.rightWidth, max))
  return rightWidth === p.rightWidth ? p : { ...p, rightWidth }
}

function Editor({
  projectId,
  projects,
}: {
  projectId: string | null
  projects: ProjectsState
}) {
  const { doc, offline, error, submit, decisions, answerDecision, plans, reviewBump } =
    useProject(projectId)

  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [captions, setCaptions] = useState(true)
  /** Track being auditioned alone. Editor-only: solo must never reach a render. */
  const [solo, setSolo] = useState<string | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [panels, setPanels] = useState<Panels>(loadPanels)
  const [optionsOpen, setOptionsOpen] = useState(false)
  /** True mid-drag, so the whole app can stop selecting text under the cursor. */
  const [resizing, setResizing] = useState(false)

  // Reload the file list when the document's asset references change — that is
  // what a new narration clip looks like from here.
  // Uploading does not touch the document, so the document-derived key cannot
  // notice it — hence a counter the drop handler bumps. `reviewBump` is the
  // same idea for review verdicts: status lives on the rows, and the
  // `asset-reviewed` broadcast is what says they changed.
  const [assetReload, setAssetReload] = useState(0)
  const assets = useAssets(
    projectId,
    `${assetReload}:${reviewBump}:${doc ? [...assetIdsInDoc(doc)].sort().join(',') : ''}`,
  )

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

  const togglePanel = (id: PanelId) =>
    setPanels((p) => {
      const next = clampPanels({
        ...p,
        open: p.open.includes(id) ? p.open.filter((x) => x !== id) : [...p.open, id],
      })
      savePanels(next)
      return next
    })

  // An open review means an agent is stalled, and a stalled agent outranks a
  // closed-by-default stack — a *new* question opens the Review panel itself.
  // Keyed on the count so dismissing the panel sticks until the next question.
  const openDecisionCount = decisions.filter((d) => d.status === 'open').length
  useEffect(() => {
    if (openDecisionCount === 0) return
    setPanels((p) => {
      if (p.open.includes('review')) return p
      const next = { ...p, open: [...p.open, 'review' as PanelId] }
      savePanels(next)
      return next
    })
  }, [openDecisionCount])

  /** Live during a drag; the preference is written once, when you let go. */
  const resize = (width: number) => setPanels((p) => clampPanels({ ...p, rightWidth: width }))

  /** Double-clicking the handle puts the stack back to its shipped width. */
  const resetWidth = () => {
    const next = clampPanels({ ...panels, rightWidth: DEFAULT_PANELS.rightWidth })
    setPanels(next)
    savePanels(next)
  }

  // A window narrow enough would otherwise leave the fixed-width stack holding
  // the whole viewport and the canvas at zero.
  useEffect(() => {
    const onResize = () => setPanels((p) => clampPanels(p))
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // VS Code's muscle memory, remapped to the stack: ⌘B toggles Files,
  // ⌘⌥B toggles Scene.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'b' || !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      togglePanel(e.altKey ? 'scene' : 'files')
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
  const stackOpen = panels.open.length > 0

  const panelBody = (id: PanelId) => {
    switch (id) {
      case 'files':
        return (
          <Assets
            state={assets}
            activeId={activeTab}
            onOpen={openFile}
            offline={offline}
            projectId={projectId}
            onUploaded={() => setAssetReload((n) => n + 1)}
          />
        )
      case 'scene':
        return (
          <Inspector
            doc={doc}
            currentScene={at?.scene ?? null}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
            submit={submit}
          />
        )
      case 'review':
        return (
          <Review
            decisions={decisions}
            plans={plans}
            files={assets.files}
            onAnswer={answerDecision}
            onSeek={(t) => {
              setPlaying(false)
              setTime(t)
            }}
          />
        )
    }
  }

  return (
    <div className={`app${resizing ? ' resizing' : ''}`}>
      <div className="shell">
        <Sidebar projects={projects} currentId={projectId} offline={offline} />

        <div className="workspace">
          <header>
            <span className="doc-glyph">◈</span>
            <span className="doc-title">{doc.name}</span>
            {offline && <span className="badge offline">offline demo — not a real project</span>}
            {error && <span className="badge error">{error}</span>}
            <span className="grow" />
            {projectId && !offline && <ReviewModeToggle projectId={projectId} />}
            <div className="options">
              <button
                className={`icon-btn options-btn${optionsOpen ? ' on' : ''}`}
                onClick={() => setOptionsOpen((o) => !o)}
                title="panels"
              >
                ⋯
                {/* A waiting agent question must be visible even with every
                    panel closed — the dot is the stalled agent knocking. */}
                {openDecisionCount > 0 && !panels.open.includes('review') && (
                  <span className="options-dot" />
                )}
              </button>
              {optionsOpen && (
                <>
                  <div className="menu-backdrop" onClick={() => setOptionsOpen(false)} />
                  <div className="options-menu">
                    {(Object.keys(PANEL_TITLES) as PanelId[]).map((id) => (
                      <button key={id} onClick={() => togglePanel(id)}>
                        <span className="options-check">
                          {panels.open.includes(id) ? '✓' : ''}
                        </span>
                        {PANEL_TITLES[id]}
                        {id === 'review' && openDecisionCount > 0 && (
                          <span className="decision-badge">{openDecisionCount}</span>
                        )}
                        <span className="grow" />
                        {id === 'files' && <span className="options-key">⌘B</span>}
                        {id === 'scene' && <span className="options-key">⌘⌥B</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </header>

          <main className="workbench">
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
                {/* The canvas is hidden, never unmounted: Pixi's app and its
                    ticker are expensive to rebuild, and tearing one down to
                    read a text file would restart the preview every time you
                    glance at one. */}
                <div
                  className="stage"
                  style={{ display: activeTab === 'canvas' ? 'flex' : 'none' }}
                >
                  <Preview doc={doc} time={time} />
                  {/* Only appears for a scene that has a camera — otherwise
                      the frame is the canvas and there is nothing to say. */}
                  <CameraFrame doc={doc} time={time} />
                  {captions && <CaptionOverlay doc={doc} time={time} playing={playing} />}
                </div>
                {activeFile && <FileViewer key={activeFile.id} file={activeFile} />}
              </div>

              <AudioMixer doc={doc} time={time} playing={playing} muted={muted} solo={solo} />
              <Timeline
                doc={doc}
                time={time}
                playing={playing}
                muted={muted}
                captions={captions}
                solo={solo}
                onSolo={setSolo}
                submit={submit}
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
            </section>

            {stackOpen && (
              <Splitter
                width={panels.rightWidth}
                onResize={resize}
                onReset={resetWidth}
                onCommit={() => savePanels(panels)}
                onDragging={setResizing}
              />
            )}
            {stackOpen && (
              <aside className="stack" style={{ width: panels.rightWidth }}>
                {panels.open.map((id) => (
                  <section key={id} className="stack-panel">
                    <div className="stack-head">
                      <span>{PANEL_TITLES[id]}</span>
                      {id === 'files' && (
                        <span className="count">{assets.files?.length ?? ''}</span>
                      )}
                      {id === 'review' && openDecisionCount > 0 && (
                        <span className="decision-badge">{openDecisionCount}</span>
                      )}
                      <span className="grow" />
                      {id === 'files' && (
                        <button
                          className="icon-btn"
                          onClick={() => void assets.reload()}
                          title="refresh"
                        >
                          ⟳
                        </button>
                      )}
                      <button className="icon-btn" onClick={() => togglePanel(id)} title="close">
                        ✕
                      </button>
                    </div>
                    <div className="stack-body">{panelBody(id)}</div>
                  </section>
                ))}
              </aside>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}

/**
 * The drag handle between the editor and the panel stack.
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
  width,
  onResize,
  onReset,
  onCommit,
  onDragging,
}: {
  width: number
  onResize: (width: number) => void
  onReset: () => void
  onCommit: () => void
  onDragging: (dragging: boolean) => void
}) {
  const from = useRef<{ x: number; width: number } | null>(null)

  return (
    <div
      className="splitter"
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
        onResize(start.width - (e.clientX - start.x))
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
