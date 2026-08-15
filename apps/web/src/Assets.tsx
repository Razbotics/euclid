import { useCallback, useEffect, useState } from 'react'
import { buildAssetTree, type AssetFolder, type AssetRecord } from '@euclid/dsl'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

type Row = AssetRecord & { usedBy: boolean }

/**
 * The project's files, as a file explorer scoped to this project.
 *
 * Assets were previously invisible: `generate_narration` mints one and its id
 * appears in exactly one tool response, so a stale clip from a regenerated
 * scene sat in R2 with nothing able to show or remove it. Folders are virtual
 * — derived from each file's `path` by `buildAssetTree`, the same helper the
 * MCP `list_assets` tool uses — so renaming is a single PATCH and there are no
 * empty folders to clean up.
 */
export function Assets({
  projectId,
  reloadKey,
}: {
  projectId: string
  reloadKey?: string | number
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/projects/${projectId}/assets`, { credentials: 'include' })
      if (!res.ok) throw new Error(`${res.status}`)
      const { assets } = (await res.json()) as { assets: Row[] }
      setRows(assets)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const rename = async (row: Row) => {
    const next = window.prompt('New path', row.path)
    if (!next || next === row.path) return
    setBusy(row.id)
    const res = await fetch(`${API}/api/assets/${row.id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: next }),
    })
    setBusy(null)
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string }
      window.alert(`Could not move: ${body.detail ?? body.error ?? res.status}`)
      return
    }
    await load()
  }

  const remove = async (row: Row) => {
    // The guard lives in the API — it knows what the document references. The
    // UI only has to explain the refusal.
    if (!window.confirm(`Delete ${row.path}?`)) return
    setBusy(row.id)
    let res = await fetch(`${API}/api/assets/${row.id}`, { method: 'DELETE', credentials: 'include' })
    if (res.status === 409) {
      const body = (await res.json()) as { scenes?: string[] }
      const scenes = (body.scenes ?? []).join(', ') || 'the document'
      if (!window.confirm(`Still used by ${scenes}. Delete anyway and leave it pointing at nothing?`)) {
        setBusy(null)
        return
      }
      res = await fetch(`${API}/api/assets/${row.id}?force=1`, { method: 'DELETE', credentials: 'include' })
    }
    setBusy(null)
    if (!res.ok) return window.alert(`Could not delete: ${res.status}`)
    await load()
  }

  if (error) return <div className="assets"><h4>FILES</h4><span className="muted">{error}</span></div>
  if (!rows) return <div className="assets"><h4>FILES</h4><span className="muted">loading…</span></div>

  return (
    <div className="assets">
      <h4>
        FILES <span className="muted">{rows.length}</span>
      </h4>
      {rows.length === 0 ? (
        <span className="muted">no files yet</span>
      ) : (
        <Folder folder={buildAssetTree(rows)} depth={0} onRename={rename} onRemove={remove} busy={busy} />
      )}
    </div>
  )
}

function Folder({
  folder,
  depth,
  onRename,
  onRemove,
  busy,
}: {
  folder: AssetFolder
  depth: number
  onRename: (r: Row) => void
  onRemove: (r: Row) => void
  busy: string | null
}) {
  return (
    <div style={{ paddingLeft: depth === 0 ? 0 : 10 }}>
      {folder.folders.map((f) => (
        <div key={f.path}>
          <div className="asset-folder">{f.name}/</div>
          <Folder folder={f} depth={depth + 1} onRename={onRename} onRemove={onRemove} busy={busy} />
        </div>
      ))}
      {folder.files.map((file) => {
        const row = file as unknown as Row
        return (
          <div key={file.id} className="asset-file">
            <span className="asset-name" title={file.path}>
              {file.name}
            </span>
            <span className="asset-meta">
              {Math.round(file.bytes / 1024)}KB
              {file.durationSec ? ` · ${file.durationSec.toFixed(1)}s` : ''}
            </span>
            <span className="asset-actions">
              <a href={`${API}/api/assets/${file.id}`} target="_blank" rel="noreferrer" title="open">
                ↗
              </a>
              <button onClick={() => onRename(row)} disabled={busy === file.id} title="rename or move">
                ✎
              </button>
              <button onClick={() => onRemove(row)} disabled={busy === file.id} title="delete">
                ✕
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}
