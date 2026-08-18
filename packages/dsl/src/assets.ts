import type { EuclidDoc } from './document'

/**
 * A project's assets are a **scoped filesystem**: every asset is a file, and
 * folders are virtual — derived from a `path` string rather than stored as
 * rows. That keeps rename/move a single UPDATE and means there is no such
 * thing as an orphaned empty folder to garbage-collect.
 *
 * Everything here is pure so the editor, the API and the MCP tools build the
 * same tree from the same rows, and it can be tested without a browser or a
 * database.
 */

export interface AssetRecord {
  id: string
  kind: string
  mime: string
  bytes: number
  durationSec?: number | null
  path: string
  createdAt: number
}

export interface AssetFile extends AssetRecord {
  /** Final path segment — what the explorer shows and rename edits. */
  name: string
}

export interface AssetFolder {
  /** '' for the root; otherwise the folder's absolute path without a trailing slash. */
  path: string
  name: string
  folders: AssetFolder[]
  files: AssetFile[]
}

/**
 * Characters a segment may not contain: control characters and a backslash.
 * Deliberately narrow — `-`, `.` and spaces are ordinary in filenames, and a
 * forward slash cannot appear because segments come from splitting on it.
 */
const ILLEGAL_SEGMENT = /[\u0000-\u001f\u007f\\]/

export class AssetPathError extends Error {}

/**
 * Canonicalise a virtual path: always absolute, no empty or relative segments,
 * no trailing slash. Rejects `..` outright rather than resolving it — these
 * paths never touch a filesystem, so traversal has no legitimate meaning here
 * and silently resolving it would let one project name another's file.
 */
export function normalizeAssetPath(input: string): string {
  const out: string[] = []
  for (const raw of input.split('/')) {
    const seg = raw.trim()
    if (seg === '') continue // collapses '//' and a trailing slash
    if (seg === '.' || seg === '..') {
      throw new AssetPathError(`"${input}" contains a relative segment ("${seg}")`)
    }
    if (ILLEGAL_SEGMENT.test(seg)) {
      throw new AssetPathError(`"${input}" contains an illegal character`)
    }
    out.push(seg)
  }
  if (out.length === 0) throw new AssetPathError('path must name a file')
  return `/${out.join('/')}`
}

/** The folder holding a path ('' when the file sits at the root). */
export function assetDirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? '' : path.slice(0, i)
}

/** The final segment of a path. */
export function assetBasename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  // A generated 3D model. `import_mesh` reads one into a mesh node, decimated
  // to fit the document budget.
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
}

/**
 * Where an asset lands when nothing named it — grouped by kind so a project
 * is navigable the moment it has more than one file. Short id suffix because
 * two narration clips for the same scene must not collide.
 */
export function defaultAssetPath(kind: string, mime: string, assetId: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'bin'
  return `/${kind}/${assetId.slice(0, 8)}.${ext}`
}

/** Group flat records into a folder tree, folders and files each sorted by name. */
export function buildAssetTree(assets: AssetRecord[]): AssetFolder {
  const root: AssetFolder = { path: '', name: '', folders: [], files: [] }

  const folderAt = (dir: string): AssetFolder => {
    if (dir === '') return root
    let node = root
    let sofar = ''
    for (const seg of dir.split('/').filter(Boolean)) {
      sofar += `/${seg}`
      let next = node.folders.find((f) => f.name === seg)
      if (!next) {
        next = { path: sofar, name: seg, folders: [], files: [] }
        node.folders.push(next)
      }
      node = next
    }
    return node
  }

  for (const a of assets) {
    folderAt(assetDirname(a.path)).files.push({ ...a, name: assetBasename(a.path) })
  }

  const sort = (f: AssetFolder): AssetFolder => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name)).forEach(sort)
    f.files.sort((a, b) => a.name.localeCompare(b.name))
    return f
  }
  return sort(root)
}

/**
 * Every assetId the document currently depends on.
 *
 * Deleting one of these would leave the document holding an id that resolves
 * to nothing — the invariant Phase 2 established when it made `storeAsset`
 * write the row only after the bytes land. Today only narration audio
 * references an asset; `video`/`audio` nodes will join this list, so callers
 * should treat it as "ask the document", not "check narration".
 */
export function assetIdsInDoc(doc: EuclidDoc): Set<string> {
  const ids = new Set<string>()
  for (const scene of doc.scenes) {
    const id = scene.narration?.audio?.assetId
    if (id) ids.add(id)
  }
  return ids
}
