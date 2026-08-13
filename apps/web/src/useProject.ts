import { useCallback, useEffect, useRef, useState } from 'react'
import { applyOps, type EuclidDoc, type Op, type OpEnvelope } from '@euclid/dsl'
import { demoDoc } from './demo'

const API = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787'

export interface ProjectState {
  doc: EuclidDoc | null
  version: number
  offline: boolean
  error: string | null
  submit: (ops: Op[]) => void
}

/**
 * Live document sync. No CRDT magic — the ProjectDO serializes every write and
 * broadcasts numbered versions; we apply envelopes in order via the shared
 * reducer and refetch on any gap or rejection. Agent edits made over MCP arrive
 * through the exact same channel as our own edits.
 */
export function useProject(projectId: string | null): ProjectState {
  const [doc, setDoc] = useState<EuclidDoc | null>(projectId ? null : demoDoc)
  const [offline, setOffline] = useState(projectId === null)
  const [error, setError] = useState<string | null>(null)
  const versionRef = useRef(0)
  const [version, setVersion] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)

  const refetch = useCallback(async () => {
    if (!projectId) return
    const res = await fetch(`${API}/api/projects/${projectId}/doc`, { credentials: 'include' })
    if (!res.ok) throw new Error(`doc fetch failed: ${res.status}`)
    const body = (await res.json()) as { doc: EuclidDoc; version: number }
    versionRef.current = body.version
    setVersion(body.version)
    setDoc(body.doc)
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    let ws: WebSocket | null = null

    refetch()
      .then(() => {
        if (cancelled) return
        ws = new WebSocket(`${API.replace(/^http/, 'ws')}/api/projects/${projectId}/ws`)
        wsRef.current = ws
        ws.onmessage = (ev) => {
          const msg = JSON.parse(ev.data as string) as {
            type: string
            version?: number
            envelope?: OpEnvelope
          }
          if (msg.type !== 'ops' || !msg.envelope || msg.version === undefined) return
          if (msg.version === versionRef.current + 1) {
            versionRef.current = msg.version
            setVersion(msg.version)
            setDoc((d) => (d ? applyOps(d, msg.envelope!.ops) : d))
          } else if (msg.version > versionRef.current + 1) {
            void refetch()
          }
        }
        ws.onclose = () => {
          if (!cancelled) setError('live connection lost — reload to resync')
        }
      })
      .catch(() => {
        if (cancelled) return
        setOffline(true)
        setDoc(demoDoc)
      })

    return () => {
      cancelled = true
      ws?.close()
    }
  }, [projectId, refetch])

  const submit = useCallback(
    (ops: Op[]) => {
      if (offline || !projectId) {
        // demo mode: apply locally through the same reducer
        setDoc((d) => (d ? applyOps(d, ops) : d))
        return
      }
      void (async () => {
        const res = await fetch(`${API}/api/projects/${projectId}/ops`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: crypto.randomUUID(),
            baseVersion: versionRef.current,
            actor: { type: 'user' },
            ops,
          }),
        })
        // our own change comes back over the WebSocket; on conflict just resync
        if (!res.ok) void refetch()
      })()
    },
    [offline, projectId, refetch],
  )

  return { doc, version, offline, error, submit }
}
