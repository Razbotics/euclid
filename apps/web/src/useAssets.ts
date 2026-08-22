import { useCallback, useEffect, useState } from 'react'
import type { AssetRecord } from '@euclid/dsl'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

/** A row as the API serves it: the record plus whether the document needs it. */
export type ProjectFile = AssetRecord & { usedBy: boolean }

export interface AssetsState {
  /** null while the first load is in flight; [] for the offline demo. */
  files: ProjectFile[] | null
  error: string | null
  /** Asset id a rename/delete is in flight for, so its row can go inert. */
  busy: string | null
  reload: () => Promise<void>
  rename: (file: ProjectFile) => Promise<void>
  remove: (file: ProjectFile) => Promise<void>
}

/**
 * Where the bytes live. Same URL the narration player and the tabs use.
 *
 * `variant: 'proxy'` asks for the low-resolution, densely-keyframed copy — the
 * right answer for anything a *person* scrubs, and the wrong one for anything
 * that has to match the export. The API falls back to the original when no
 * proxy exists, so asking is always safe; what is not safe is asking from a
 * capture path, which is why `preload.ts` never does.
 */
export function assetUrl(id: string, variant?: 'proxy'): string {
  return `${API}/api/assets/${id}${variant ? `?variant=${variant}` : ''}`
}

/**
 * The project's file list, lifted out of the explorer.
 *
 * It moved up here because the explorer stopped being the only reader: opening
 * a file puts a tab in the editor, and a tab needs the record (mime, size,
 * path) to know what viewer to draw. One fetch, one truth — and when a delete
 * succeeds the list shrinks, which is what closes the stale tab.
 */
export function useAssets(projectId: string | null, reloadKey?: string | number): AssetsState {
  const [files, setFiles] = useState<ProjectFile[] | null>(projectId ? null : [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    try {
      const res = await fetch(`${API}/api/projects/${projectId}/assets`, { credentials: 'include' })
      if (!res.ok) throw new Error(`${res.status}`)
      const { assets } = (await res.json()) as { assets: ProjectFile[] }
      setFiles(assets)
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload, reloadKey])

  const rename = useCallback(
    async (file: ProjectFile) => {
      const next = window.prompt('New path', file.path)
      if (!next || next === file.path) return
      setBusy(file.id)
      const res = await fetch(`${API}/api/assets/${file.id}`, {
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
      await reload()
    },
    [reload],
  )

  const remove = useCallback(
    async (file: ProjectFile) => {
      // The guard lives in the API — it knows what the document references. The
      // UI only has to explain the refusal.
      if (!window.confirm(`Delete ${file.path}?`)) return
      setBusy(file.id)
      let res = await fetch(`${API}/api/assets/${file.id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      if (res.status === 409) {
        const body = (await res.json()) as { scenes?: string[] }
        const scenes = (body.scenes ?? []).join(', ') || 'the document'
        if (
          !window.confirm(`Still used by ${scenes}. Delete anyway and leave it pointing at nothing?`)
        ) {
          setBusy(null)
          return
        }
        res = await fetch(`${API}/api/assets/${file.id}?force=1`, {
          method: 'DELETE',
          credentials: 'include',
        })
      }
      setBusy(null)
      if (!res.ok) return window.alert(`Could not delete: ${res.status}`)
      await reload()
    },
    [reload],
  )

  return { files, error, busy, reload, rename, remove }
}

/** 341KB, 1.2MB — sized to be read at a glance in a tree, not to be exact. */
/**
 * Send a user's own file to their project.
 *
 * This is the ingest path — plans/003 chose "users bring their own media", so
 * there is no fetcher and this endpoint is how footage enters at all. The
 * server decides `kind` from the file's type rather than trusting anything
 * sent here, and refuses what is not on its allowlist; the message it gives
 * back is shown as-is, because "video/x-matroska cannot be uploaded" is more
 * use than "upload failed".
 */
export async function uploadFile(projectId: string, file: File): Promise<string> {
  const res = await fetch(
    `${API}/api/projects/${projectId}/assets?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file,
    },
  )
  const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string; assetId?: string }
  if (!res.ok) throw new Error(body.detail ?? body.error ?? `upload failed (${res.status})`)
  return body.assetId!
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}
