import { useState } from 'react'
import { buildAssetTree, type AssetFolder, type AssetFile } from '@euclid/dsl'
import { assetUrl, formatBytes, type AssetsState, type ProjectFile } from './useAssets'
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
}: {
  state: AssetsState
  activeId: string | null
  onOpen: (file: ProjectFile) => void
  offline?: boolean
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  if (offline) return <p className="explorer-note">the offline demo has no project files</p>
  if (state.error) return <p className="explorer-note">{state.error}</p>
  if (!state.files) return <p className="explorer-note">loading…</p>
  if (state.files.length === 0) return <p className="explorer-note">no files yet</p>

  return (
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
      <span className="asset-meta">
        {formatBytes(file.bytes)}
        {file.durationSec ? ` · ${file.durationSec.toFixed(1)}s` : ''}
      </span>
      <span className="asset-actions" onClick={(e) => e.stopPropagation()}>
        <a href={assetUrl(file.id)} target="_blank" rel="noreferrer" title="open in a browser tab">
          ↗
        </a>
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
