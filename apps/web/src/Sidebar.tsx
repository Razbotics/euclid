import { useEffect, useRef, useState } from 'react'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

export interface ProjectRow {
  id: string
  name: string
  created_at: number
}

export type ProjectsState =
  | { status: 'loading' }
  | { status: 'ready'; projects: ProjectRow[] }
  | { status: 'error'; message: string }

/**
 * One fetch for the whole shell: the sidebar draws the list, and the App uses
 * the same result to auto-open the newest project on a bare `/`. This replaced
 * the standalone project-list page — the reason that page existed (agent-made
 * projects are invisible without a list, since their ids only appear in tool
 * responses) is now served by the sidebar, which is reachable from anywhere.
 */
export function useProjects(): ProjectsState {
  const [state, setState] = useState<ProjectsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`${API}/api/projects`, { credentials: 'include' })
        if (!res.ok) throw new Error(`${res.status}`)
        const { projects } = (await res.json()) as { projects: ProjectRow[] }
        if (!cancelled) setState({ status: 'ready', projects })
      } catch {
        // Most likely the API isn't running; the demo still works offline.
        if (!cancelled) setState({ status: 'error', message: `can't reach the API at ${API}` })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

/**
 * The sidebar has two modes, Claude Code's own pair, and the top-left toggle
 * switches between them:
 *
 * - **docked** (the default) — a real column, always visible, pushing the
 *   workspace aside. Nothing about it reacts to hover.
 * - **hover** — the column is gone entirely; only the toggle button remains,
 *   at the far left of the header, and *hovering it* slides the sidebar out
 *   as an overlay. Clicking the button docks it again.
 *
 * The mode is a preference, so it is remembered.
 */
export type SidebarMode = 'docked' | 'hover'

const SIDEBAR_KEY = 'euclid.sidebar'

export function useSidebarMode(): [SidebarMode, () => void] {
  const [mode, setMode] = useState<SidebarMode>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === 'hover' ? 'hover' : 'docked'
    } catch {
      return 'docked'
    }
  })
  const toggle = () =>
    setMode((m) => {
      const next = m === 'docked' ? 'hover' : 'docked'
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next)
      } catch {
        // Private-mode storage failure must not swallow the change.
      }
      return next
    })
  return [mode, toggle]
}

export function Sidebar({
  projects,
  currentId,
  offline,
  mode,
  onToggleMode,
}: {
  projects: ProjectsState
  currentId: string | null
  offline: boolean
  mode: SidebarMode
  onToggleMode: () => void
}) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  // Leaving the hover zone closes the flyout after a beat — an immediate close
  // makes the diagonal path from the button into the list impossible to travel.
  const closeTimer = useRef<number | null>(null)

  const enter = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
    setOpen(true)
  }
  const leave = () => {
    if (menu) return // an open settings menu pins the flyout
    closeTimer.current = window.setTimeout(() => {
      setOpen(false)
      closeTimer.current = null
    }, 180)
  }

  const content = (
    <>
      <div className="side-section">Projects</div>
      <div className="side-list">
        {projects.status === 'loading' && <p className="side-note">loading…</p>}
        {projects.status === 'error' && <p className="side-note error">{projects.message}</p>}
        {projects.status === 'ready' && projects.projects.length === 0 && (
          <p className="side-note">
            No projects yet — an agent creates them over MCP with <code>create_project</code>.
          </p>
        )}
        {projects.status === 'ready' &&
          projects.projects.map((p) => (
            <a
              key={p.id}
              className={`side-item${p.id === currentId ? ' active' : ''}`}
              href={`?project=${p.id}`}
              title={p.id}
            >
              <span className="side-item-name">{p.name}</span>
              <span className="side-item-when">{formatWhen(p.created_at)}</span>
            </a>
          ))}
        <a className={`side-item demo${offline ? ' active' : ''}`} href="?demo=1">
          <span className="side-item-name">offline demo</span>
        </a>
      </div>

      {menu && (
        <div className="user-menu">
          <div className="user-menu-id">
            <span className="avatar">D</span>
            <span>
              dev-user
              <small>local session</small>
            </span>
          </div>
          <button disabled title="not built yet">
            Settings…
          </button>
          <button disabled title="not built yet">
            Sign out
          </button>
        </div>
      )}
      <button
        className={`user-btn${menu ? ' on' : ''}`}
        onClick={() => setMenu((m) => !m)}
        title="account & settings"
      >
        <span className="avatar">D</span>
        <span className="user-name">dev-user</span>
      </button>
    </>
  )

  if (mode === 'docked') {
    return (
      <nav className="sidebar-docked">
        <div className="side-head">
          <SidebarToggle mode={mode} onClick={onToggleMode} />
          <span className="side-title">Euclid</span>
          {offline && <span className="side-badge">offline</span>}
        </div>
        {content}
      </nav>
    )
  }

  // Hover mode: only the toggle button sits in the header, and the flyout is
  // an overlay revealed by hovering it. The flyout is a *child* of the hover
  // zone, so leaving fires only once the pointer has left button and panel
  // both — opening it must never reflow the editor.
  return (
    <div className="side-hover" onMouseEnter={enter} onMouseLeave={leave}>
      <SidebarToggle mode={mode} onClick={onToggleMode} />
      <div className={`side-flyout${open ? ' open' : ''}`}>
        <div className="side-head">
          <SidebarToggle mode={mode} onClick={onToggleMode} />
          <span className="side-title">Euclid</span>
          {offline && <span className="side-badge">offline</span>}
        </div>
        {content}
      </div>
    </div>
  )
}

function SidebarToggle({ mode, onClick }: { mode: SidebarMode; onClick: () => void }) {
  return (
    <button
      className="icon-btn side-toggle"
      onClick={onClick}
      title={mode === 'docked' ? 'collapse sidebar (hover the button to peek)' : 'pin sidebar open'}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" />
        <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" />
      </svg>
    </button>
  )
}

/** Relative for recent work, absolute once it stops being "when did I do that". */
function formatWhen(createdAt: number): string {
  const seconds = Math.max(0, (Date.now() - createdAt) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`
  return new Date(createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
