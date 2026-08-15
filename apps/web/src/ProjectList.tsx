import { useEffect, useState } from 'react'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

interface ProjectRow {
  id: string
  name: string
  created_at: number
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; projects: ProjectRow[] }
  | { status: 'error'; message: string }

/**
 * Landing view: every project, newest first.
 *
 * Exists because an agent creates projects over MCP and the id only ever
 * appears in a tool response — so without this the work is invisible unless
 * someone copies a UUID by hand. Opening the editor with no `?project=`
 * used to show the offline demo, which looks identical to "connected but
 * not syncing" and is exactly how that confusion starts.
 */
export function ProjectList() {
  const [state, setState] = useState<State>({ status: 'loading' })

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

  return (
    <div className="app">
      <header>
        <h1>Euclid</h1>
        <span className="project-name">projects</span>
      </header>
      <div className="project-list">
        {state.status === 'loading' && <p className="list-note">loading projects…</p>}

        {state.status === 'error' && (
          <p className="list-note error">
            {state.message} — start it with <code>pnpm dev:api</code>, or{' '}
            <a href="?demo=1">open the offline demo</a>.
          </p>
        )}

        {state.status === 'ready' && state.projects.length === 0 && (
          <p className="list-note">
            No projects yet. An agent creates them over MCP with{' '}
            <code>create_project</code>, or <a href="?demo=1">open the offline demo</a>.
          </p>
        )}

        {state.status === 'ready' && state.projects.length > 0 && (
          <>
            <ul>
              {state.projects.map((p) => (
                <li key={p.id}>
                  <a href={`?project=${p.id}`}>
                    <span className="project-title">{p.name}</span>
                    <span className="project-meta">
                      {formatWhen(p.created_at)}
                      <code>{p.id.slice(0, 8)}</code>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="list-note">
              {state.projects.length} project{state.projects.length === 1 ? '' : 's'} ·{' '}
              <a href="?demo=1">offline demo</a>
            </p>
          </>
        )}
      </div>
    </div>
  )
}

/** Relative for recent work, absolute once it stops being "when did I do that". */
function formatWhen(createdAt: number): string {
  const seconds = Math.max(0, (Date.now() - createdAt) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return new Date(createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}
