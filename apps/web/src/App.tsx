import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { assetBasename, assetIdsInDoc, docDuration, globalToScene } from '@euclid/dsl'
import { useProject } from './useProject'
import { useAssets } from './useAssets'
import { Preview } from './Preview'
import { Timeline } from './Timeline'
import { Inspector } from './Inspector'
import { Assets } from './Assets'
import { FileViewer, fileGlyph } from './FileViewer'
import { CameraFrame } from './Camera'
import { CaptionOverlay } from './Narration'
import { AudioMixer } from './AudioMixer'
import { Review, ReviewModeToggle } from './Review'
import { Sidebar, useProjects, useSidebarMode, type ProjectsState } from './Sidebar'

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
  const [sidebarMode, toggleSidebarMode] = useSidebarMode()
  const sidebar = (
    <Sidebar
      projects={projects}
      currentId={null}
      offline={false}
      mode={sidebarMode}
      onToggleMode={toggleSidebarMode}
    />
  )
  return (
    <div className="app">
      <div className="shell">
        {sidebarMode === 'docked' && sidebar}
        <div className="workspace">
          {sidebarMode === 'hover' && <header>{sidebar}</header>}
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

/** Panel-header controls as drawn icons — text glyphs render tiny and shift
 *  per font, and a control you have to aim at is a control that gets missed. */
function GlyphIcon({ kind }: { kind: 'refresh' | 'expand' | 'restore' | 'close' }) {
  const path = {
    refresh: (
      <>
        <path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" />
        <path d="M13.4 2.6v3.2h-3.2" />
      </>
    ),
    expand: <path d="M9.5 2.5h4v4M13.3 2.7 9.2 6.8M6.5 13.5h-4v-4M2.7 13.3l4.1-4.1" />,
    restore: <path d="M13.5 6.5h-4v-4M13.3 2.7 9.2 6.8M2.5 9.5h4v4M6.6 9.4l-4.1 4.1" />,
    close: <path d="m4 4 8 8M12 4l-8 8" />,
  }[kind]
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

/** The ⋯ menu draws each panel with a glyph, Claude Code style. */
function PanelIcon({ id }: { id: PanelId }) {
  const path = {
    // a folder
    files: <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" />,
    // stacked layers
    scene: (
      <>
        <path d="M8 2.5 14 6 8 9.5 2 6z" />
        <path d="M2.5 9.5 8 12.5l5.5-3" />
      </>
    ),
    // a check in a circle
    review: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M5.5 8.2 7.3 10l3.2-3.6" />
      </>
    ),
  }[id]
  return (
    <svg
      className="options-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  )
}

interface Panels {
  open: PanelId[]
  rightWidth: number
  /** Relative heights of the stack's cards, as flex-grow weights keyed by
   *  card id ('viewer' included). Absent means an equal share. */
  sizes: Record<string, number>
}
const PANELS_KEY = 'euclid.panels.v2'
const DEFAULT_PANELS: Panels = { open: [], rightWidth: 340, sizes: {} }

/** The stack narrower than this is unusable; the canvas needs at least this
 *  much to still be the thing you are working on. The clamp always budgets
 *  for the docked sidebar — hover mode just leaves slack, which is the safe
 *  direction. */
const MIN_STACK = 220
const MIN_EDITOR = 360
const SIDEBAR_WIDTH = 252

function loadPanels(): Panels {
  try {
    const raw = window.localStorage.getItem(PANELS_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Panels>
      const valid = (x: unknown): x is PanelId =>
        x === 'files' || x === 'scene' || x === 'review'
      const sizes: Record<string, number> = {}
      if (p.sizes && typeof p.sizes === 'object') {
        for (const [k, v] of Object.entries(p.sizes)) {
          if (typeof v === 'number' && v > 0 && Number.isFinite(v)) sizes[k] = v
        }
      }
      return {
        open: Array.isArray(p.open) ? p.open.filter(valid) : [],
        // A stored width from a wider window is clamped on the first layout
        // pass, not trusted — see the resize effect.
        rightWidth: Number(p.rightWidth) || DEFAULT_PANELS.rightWidth,
        sizes,
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
  const max = Math.max(MIN_STACK, window.innerWidth - SIDEBAR_WIDTH - MIN_EDITOR)
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
  const [sidebarMode, toggleSidebarMode] = useSidebarMode()
  const [optionsOpen, setOptionsOpen] = useState(false)
  /** One card can take the whole stack; the rest collapse to their headers.
   *  A viewing choice, like solo — deliberately not persisted. The open
   *  file's viewer is a card too, so it participates. */
  const [maximized, setMaximized] = useState<PanelId | 'viewer' | null>(null)
  /** Set mid-drag (with its axis, for the cursor), so the whole app can stop
   *  selecting text under the pointer. */
  const [resizing, setResizing] = useState<'x' | 'y' | null>(null)

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

  // A file opens as its own card in the right stack — the centre belongs to
  // the canvas and timeline alone. One file at a time; clicking the same file
  // again closes it. Library rows open too: same assets API, same viewer —
  // the user owns the bytes, membership is just a link (plans/010).
  const [viewFileId, setViewFileId] = useState<string | null>(null)
  // A file deleted from the tree (or by an agent, over the same list) takes
  // its viewer with it — a viewer pointing at a 404 is worse than none.
  useEffect(() => {
    if (!assets.files || !viewFileId) return
    const known =
      assets.files.some((f) => f.id === viewFileId) ||
      (assets.library ?? []).some((f) => f.id === viewFileId)
    if (!known) setViewFileId(null)
  }, [assets.files, assets.library, viewFileId])
  // Memoized so the viewer card sees a stable object: a library row is
  // dressed as a ProjectFile (`usedBy: false` — it is not in this document).
  const viewFile = useMemo(() => {
    if (!viewFileId) return null
    const own = assets.files?.find((f) => f.id === viewFileId)
    if (own) return own
    const lib = (assets.library ?? []).find((f) => f.id === viewFileId)
    return lib ? { ...lib, usedBy: false } : null
  }, [viewFileId, assets.files, assets.library])
  // A maximized viewer whose card just left the stack (file closed, Files
  // panel closed) must not leave every other card folded to its header.
  useEffect(() => {
    if (maximized === 'viewer' && (!viewFile || !panels.open.includes('files'))) {
      setMaximized(null)
    }
  }, [maximized, viewFile, panels.open])

  const togglePanel = (id: PanelId) => {
    setMaximized((m) => (m === id ? null : m))
    setPanels((p) => {
      const next = clampPanels({
        ...p,
        open: p.open.includes(id) ? p.open.filter((x) => x !== id) : [...p.open, id],
      })
      savePanels(next)
      return next
    })
  }

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

  /** Reweight two adjacent cards mid-drag; committed on release like widths. */
  const resizeStack = (updates: Record<string, number>) =>
    setPanels((p) => ({ ...p, sizes: { ...p.sizes, ...updates } }))

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
  const stackOpen = panels.open.length > 0

  // The stack's render order: the viewer card rides directly under Files,
  // and exists only while Files is open and a file is selected.
  const stackEntries: (PanelId | 'viewer')[] = panels.open.flatMap((id) =>
    id === 'files' && viewFile ? [id, 'viewer' as const] : [id],
  )

  const panelBody = (id: PanelId) => {
    switch (id) {
      case 'files':
        return (
          <Assets
            state={assets}
            activeId={viewFileId}
            onOpen={(f) => setViewFileId((cur) => (cur === f.id ? null : f.id))}
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

  const sidebar = (
    <Sidebar
      projects={projects}
      currentId={projectId}
      offline={offline}
      mode={sidebarMode}
      onToggleMode={toggleSidebarMode}
    />
  )

  return (
    <div className={`app${resizing ? ` resizing resizing-${resizing}` : ''}`}>
      <div className="shell">
        {sidebarMode === 'docked' && sidebar}

        <div className="workspace">
          <header>
            {sidebarMode === 'hover' && sidebar}
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
                        <PanelIcon id={id} />
                        {PANEL_TITLES[id]}
                        {id === 'review' && openDecisionCount > 0 && (
                          <span className="decision-badge">{openDecisionCount}</span>
                        )}
                        <span className="grow" />
                        {id === 'files' && <span className="options-key">⌘B</span>}
                        {id === 'scene' && <span className="options-key">⌘⌥B</span>}
                        <span className="options-check">
                          {panels.open.includes(id) ? '✓' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </header>

          <main className="workbench">
            <section className="editor">
              {/* The centre is the canvas and the timeline, nothing else —
                  files open inside the Files panel, so the preview is never
                  covered and Pixi's app never needs hiding or rebuilding. */}
              <div className="editor-body">
                <div className="stage">
                  <Preview doc={doc} time={time} />
                  {/* Only appears for a scene that has a camera — otherwise
                      the frame is the canvas and there is nothing to say. */}
                  <CameraFrame doc={doc} time={time} />
                  {captions && <CaptionOverlay doc={doc} time={time} playing={playing} />}
                </div>
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
                onDragging={(d) => setResizing(d ? 'x' : null)}
              />
            )}
            {stackOpen && (
              <aside className="stack" style={{ width: panels.rightWidth }}>
                {stackEntries.map((id, i) => {
                  const state =
                    maximized === null ? '' : maximized === id ? ' max' : ' min'
                  // Weights only apply in the even layout — a maximized card
                  // owns the column and the folded ones own nothing.
                  const grow =
                    maximized === null ? { flexGrow: panels.sizes[id] ?? 1 } : undefined
                  const seam = i > 0 && maximized === null && (
                    <StackSplitter
                      above={stackEntries[i - 1]!}
                      below={id}
                      sizes={panels.sizes}
                      onResize={resizeStack}
                      onCommit={() => savePanels(panels)}
                      onDragging={(d) => setResizing(d ? 'y' : null)}
                    />
                  )
                  const expandBtn = stackEntries.length > 1 && (
                    <button
                      className="icon-btn"
                      onClick={() => setMaximized((m) => (m === id ? null : id))}
                      title={maximized === id ? 'restore' : 'expand'}
                    >
                      <GlyphIcon kind={maximized === id ? 'restore' : 'expand'} />
                    </button>
                  )
                  // The open file is its own card, right under Files: a
                  // separate section, not a footnote inside the tree.
                  if (id === 'viewer') {
                    return (
                      <Fragment key="viewer">
                        {seam}
                        <section className={`stack-panel${state}`} style={grow}>
                          <div className="stack-head">
                            <span className="asset-glyph">{fileGlyph(viewFile!)}</span>
                            <span className="stack-title">{assetBasename(viewFile!.path)}</span>
                            <span className="grow" />
                            {expandBtn}
                            <button
                              className="icon-btn"
                              onClick={() => setViewFileId(null)}
                              title="close"
                            >
                              <GlyphIcon kind="close" />
                            </button>
                          </div>
                          <div className="stack-body">
                            {/* keyed so switching files resets the fetch state */}
                            <FileViewer key={viewFile!.id} file={viewFile!} />
                          </div>
                        </section>
                      </Fragment>
                    )
                  }
                  return (
                    <Fragment key={id}>
                      {seam}
                      <section className={`stack-panel${state}`} style={grow}>
                        <div className="stack-head">
                        <PanelIcon id={id} />
                        <span className="stack-title">{PANEL_TITLES[id]}</span>
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
                            <GlyphIcon kind="refresh" />
                          </button>
                        )}
                        {expandBtn}
                        <button className="icon-btn" onClick={() => togglePanel(id)} title="close">
                          <GlyphIcon kind="close" />
                        </button>
                      </div>
                        <div className="stack-body">{panelBody(id)}</div>
                      </section>
                    </Fragment>
                  )
                })}
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
/**
 * The seam between two adjacent cards in the stack. Dragging it trades height
 * between exactly those two — the others keep their share, because a drag
 * between Files and Scene reshaping Review too would feel haunted.
 *
 * Pixel heights are read from the DOM at drag start and converted back into
 * flex weights on each move: the weights of the pair keep their sum, so the
 * pair's combined share of the column is invariant under the drag.
 */
function StackSplitter({
  above,
  below,
  sizes,
  onResize,
  onCommit,
  onDragging,
}: {
  above: string
  below: string
  sizes: Record<string, number>
  onResize: (updates: Record<string, number>) => void
  onCommit: () => void
  onDragging: (dragging: boolean) => void
}) {
  /** A card squeezed below this is a header with a sliver of noise. */
  const MIN_CARD = 90
  const from = useRef<{ y: number; hA: number; hB: number; wA: number; wB: number } | null>(null)

  return (
    <div
      className="vsplitter"
      role="separator"
      aria-orientation="horizontal"
      title="drag to resize"
      onPointerDown={(e) => {
        const a = e.currentTarget.previousElementSibling
        const b = e.currentTarget.nextElementSibling
        if (!a || !b) return
        e.currentTarget.setPointerCapture(e.pointerId)
        from.current = {
          y: e.clientY,
          hA: a.getBoundingClientRect().height,
          hB: b.getBoundingClientRect().height,
          wA: sizes[above] ?? 1,
          wB: sizes[below] ?? 1,
        }
        onDragging(true)
      }}
      onPointerMove={(e) => {
        const s = from.current
        if (!s) return
        const total = s.hA + s.hB
        if (total <= MIN_CARD * 2) return
        const hA = Math.min(Math.max(s.hA + (e.clientY - s.y), MIN_CARD), total - MIN_CARD)
        const sum = s.wA + s.wB
        const wA = (sum * hA) / total
        onResize({ [above]: wA, [below]: sum - wA })
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
    />
  )
}

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
