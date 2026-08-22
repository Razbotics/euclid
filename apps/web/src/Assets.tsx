import { useState } from 'react'
import { buildAssetTree, type AssetFolder, type AssetFile } from '@euclid/dsl'
import { formatBytes, uploadFile, type AssetsState, type ProjectFile } from './useAssets'
import { fileGlyph, viewerKind } from './FileViewer'
import { AUDIO_DND_TYPE } from './Timeline'

/**
 * The project's files, as a file explorer scoped to this project — the left
 * panel of the workbench.
 *
 * Assets were previously invisible: `generate_narration` mints one and its id
 * appears in exactly one tool response, so a stale clip from a regenerated
 * scene sat in R2 with nothing able to show or remove it. Folders are virtual
 * — derived from each file's `path` by `buildAssetTree`, the same helper the
 * MCP `list_assets` tool uses — so renaming is a single PATCH and there are no
 * empty folders to clean up.
 *
 * Clicking a file opens it in the editor rather than navigating away: the tree
 * selects, the centre column shows. The rows themselves are state-free; the
 * list and its mutations live in `useAssets` because the tab strip reads the
 * same records.
 */
export function Assets({
  state,
  activeId,
  onOpen,
  offline,
  projectId,
  onUploaded,
}: {
  state: AssetsState
  activeId: string | null
  onOpen: (file: ProjectFile) => void
  offline?: boolean
  /** Project to upload into, and how to tell the explorer to reload after. */
  projectId?: string | null
  onUploaded?: () => void
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  // Files dragged from the desktop. The explorer already emits drags *out* of
  // itself onto the timeline, so `AUDIO_DND_TYPE` is checked first — without
  // that, dragging a clip to a lane would also read as an upload.
  const isFileDrag = (e: React.DragEvent) =>
    e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(AUDIO_DND_TYPE)

  const onDrop = async (e: React.DragEvent) => {
    if (!projectId || !isFileDrag(e)) return
    e.preventDefault()
    setOver(false)
    setFailed(null)
    const files = [...e.dataTransfer.files]
    for (const file of files) {
      setBusy(file.name)
      try {
        await uploadFile(projectId, file)
      } catch (err) {
        // Stop at the first refusal and say which file and why: uploading
        // three of five and reporting "failed" leaves the user guessing.
        setFailed(`${file.name}: ${(err as Error).message}`)
        break
      }
    }
    setBusy(null)
    onUploaded?.()
  }
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  if (offline) return <p className="explorer-note">the offline demo has no project files</p>
  if (state.error) return <p className="explorer-note">{state.error}</p>
  if (!state.files) return <p className="explorer-note">loading…</p>

  const body =
    state.files.length === 0 ? (
      <p className="explorer-note">
        no files yet — drop images, video, audio or a .glb here
      </p>
    ) : (
      <Folder
        folder={buildAssetTree(state.files)}
        depth={0}
        collapsed={collapsed}
        onToggle={toggle}
        state={state}
        activeId={activeId}
        onOpen={onOpen}
      />
    )

  if (!projectId) return body

  // The user's assets from OTHER projects, linkable into this one. Assets are
  // user-owned with project links (plans/010 phase 4) — ⊕ links, never copies.
  const linkable = (state.library ?? []).filter((f) => !f.linkedHere)

  return (
    <div
      className={`explorer-drop${over ? ' over' : ''}`}
      onDragOver={(e) => {
        if (!isFileDrag(e)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        // Only when the pointer really left the explorer: dragging across a
        // child fires dragleave for the child and would flicker the highlight.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={onDrop}
    >
      {body}
      {busy && <p className="explorer-note">uploading {busy}…</p>}
      {failed && <p className="explorer-note explorer-error">{failed}</p>}
      {linkable.length > 0 && (
        <div className="library">
          <div className="asset-folder" onClick={() => toggle('~library')}>
            <span className="twisty">{collapsed.has('~library') ? '▸' : '▾'}</span>
            library
            <span className="library-count">{linkable.length}</span>
          </div>
          {!collapsed.has('~library') && (
            // Same indent as any folder's children, so the two lists read as
            // one tree; same click-to-view, because the user owns these bytes
            // as much as the project's own.
            <div className="tree" style={{ paddingLeft: 10 }}>
              {linkable.map((f) => (
                <div
                  key={f.id}
                  className={`asset-file library-file${activeId === f.id ? ' active' : ''}`}
                  title={`${f.path} — from another project`}
                  onClick={() => onOpen({ ...f, usedBy: false })}
                >
                  <span className="asset-glyph">{fileGlyph(f)}</span>
                  <span className="asset-name">{f.path.slice(f.path.lastIndexOf('/') + 1)}</span>
                  <span className="asset-meta">{formatBytes(f.bytes)}</span>
                  <span className="asset-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={() => void state.linkIn(f.id)}
                      disabled={state.busy === f.id}
                      title="link into this project (shared, not copied)"
                    >
                      ⊕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

interface TreeProps {
  collapsed: Set<string>
  onToggle: (path: string) => void
  state: AssetsState
  activeId: string | null
  onOpen: (file: ProjectFile) => void
}

function Folder({ folder, depth, ...t }: { folder: AssetFolder; depth: number } & TreeProps) {
  return (
    <div className="tree" style={{ paddingLeft: depth === 0 ? 0 : 10 }}>
      {folder.folders.map((f) => {
        const shut = t.collapsed.has(f.path)
        return (
          <div key={f.path}>
            <div className="asset-folder" onClick={() => t.onToggle(f.path)}>
              <span className="twisty">{shut ? '▸' : '▾'}</span>
              {f.name}
            </div>
            {!shut && <Folder folder={f} depth={depth + 1} {...t} />}
          </div>
        )
      })}
      {folder.files.map((file) => (
        <FileRow key={file.id} file={file} {...t} />
      ))}
    </div>
  )
}

function FileRow({ file, state, activeId, onOpen }: { file: AssetFile } & TreeProps) {
  // buildAssetTree carries every record field through and adds `name`, so the
  // row it hands back is still the row the API served.
  const row = file as ProjectFile & { name: string }
  const busy = state.busy === file.id

  // An audio file is draggable straight onto a timeline lane — the shortest
  // path from "the project has music" to "the video has music". The payload
  // carries the duration so a lane can draw the clip before the file loads;
  // when the producer never recorded one the timeline probes for it.
  const audio = viewerKind(file.mime, file.path) === 'audio'

  return (
    <div
      className={`asset-file${activeId === file.id ? ' active' : ''}${audio ? ' draggable' : ''}`}
      onClick={() => onOpen(row)}
      title={audio ? `${file.path} — drag onto a timeline lane` : file.path}
      draggable={audio}
      onDragStart={(e) => {
        e.dataTransfer.setData(
          AUDIO_DND_TYPE,
          JSON.stringify({ assetId: file.id, name: file.name, durationSec: file.durationSec ?? null }),
        )
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <span className="asset-glyph">{fileGlyph(row)}</span>
      <span className="asset-name">{file.name}</span>
      {/* Review state is a dot, not a word: approved is the quiet normal and
          earns nothing; pending and rejected are what the queue will explain. */}
      {row.reviewStatus === 'pending' && (
        <span className="review-dot pending" title="pending review" />
      )}
      {row.reviewStatus === 'rejected' && (
        <span
          className="review-dot rejected"
          title={`rejected${row.reviewNote ? `: ${row.reviewNote}` : ''}`}
        />
      )}
      <span className="asset-meta">
        {formatBytes(file.bytes)}
        {file.durationSec ? ` · ${file.durationSec.toFixed(1)}s` : ''}
      </span>
      <span className="asset-actions" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => state.rename(row)} disabled={busy} title="rename or move">
          ✎
        </button>
        <button onClick={() => state.remove(row)} disabled={busy} title="delete">
          ✕
        </button>
      </span>
    </div>
  )
}
