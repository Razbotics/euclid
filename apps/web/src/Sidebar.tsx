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
 * responses) is now served by the flyout, which is reachable from anywhere.
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
 * The left rail, Claude Code style: a thin strip that is always there, and a
 * flyout that expands over the canvas on hover. The flyout is an overlay, not
 * a column — opening it must never reflow the editor, or glancing at the
 * project list would bounce the canvas every time.
 */
export function Sidebar({
  projects,
  currentId,
  offline,
}: {
  projects: ProjectsState
  currentId: string | null
  offline: boolean
}) {
  const [open, setOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  // Leaving the rail closes the flyout after a beat — an immediate close makes
  // the diagonal path from rail to list impossible to travel.
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

  return (
    <nav className="sidebar" onMouseEnter={enter} onMouseLeave={leave}>
      <div className="side-rail">
        <a className="side-logo" href="?" title="Euclid">
          ◈
        </a>
        <span className="grow" />
        <UserButton compact onToggle={() => setMenu((m) => !m)} open={menu} />
      </div>

      <div className={`side-flyout${open ? ' open' : ''}`}>
        <div className="side-head">
          <span className="side-title">Euclid</span>
          {offline && <span className="side-badge">offline</span>}
        </div>

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
        <UserButton onToggle={() => setMenu((m) => !m)} open={menu} />
      </div>
    </nav>
  )
}

/**
 * The account button anchors the bottom of both the rail and the flyout; the
 * menu it opens is the future settings surface, present now so the spot where
 * settings will live is already discoverable.
 */
function UserButton({
  compact = false,
  onToggle,
  open,
}: {
  compact?: boolean
  onToggle: () => void
  open: boolean
}) {
  return (
    <button
      className={`user-btn${compact ? ' compact' : ''}${open ? ' on' : ''}`}
      onClick={onToggle}
      title="account & settings"
    >
      <span className="avatar">D</span>
      {!compact && <span className="user-name">dev-user</span>}
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
