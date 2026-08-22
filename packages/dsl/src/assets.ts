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
  /** Measured from the bytes; absent until the render worker has probed it. */
  width?: number | null
  height?: number | null
  fps?: number | null
  probedAt?: number | null
  /** Seconds at which the picture cuts. Null until the file has been watched. */
  shots?: number[] | null
  shotsAt?: number | null
  /**
   * Size of the scrubbing proxy, once one exists.
   *
   * Null with `proxyAt` null means "not transcoded yet"; null with `proxyAt`
   * set means the worker considered it and stored nothing. There is no third
   * state and no error column, because a missing proxy is never broken — the
   * original is served instead, so the only consequence is that scrubbing is
   * slower.
   */
  proxyBytes?: number | null
  proxyAt?: number | null
}

/**
 * The scrubbing proxy format, as numbers rather than as ffmpeg flags.
 *
 * A proxy exists so the **editor** can scrub real footage; the export and
 * `preview_frames` always read the original. Two separate things make scrubbing
 * slow and this addresses both:
 *
 * - **Bytes.** The editor fetches a clip whole and seeks inside a blob URL, so
 *   the file size is the wait before the first frame appears at all.
 * - **Keyframe distance**, which is the less obvious half and often the larger
 *   one. Seeking to a frame means decoding forward from the keyframe before it,
 *   so footage carrying a ten-second GOP — ordinary for a camera original —
 *   costs up to ten seconds of decoding per scrub. A proxy keyframed every
 *   second bounds that, regardless of how small the picture is.
 */
export const PROXY = {
  /** Tallest a proxy gets. Sources at or under this are only re-keyframed. */
  maxHeight: 540,
  /**
   * A source no larger than this is already comfortable to scrub, so
   * transcoding it would spend worker time to save nothing.
   */
  maxDirectBytes: 8 * 1024 * 1024,
  /** Visually adequate at 540p and small; this is a preview, not a deliverable. */
  crf: 28,
  /** Seconds between keyframes — the number the seek latency is bounded by. */
  gopSeconds: 1,
} as const

/**
 * Whether this file is worth transcoding.
 *
 * Pure and shared, so the worker's decision and every read-out of it come from
 * one predicate. That is what makes the *absence* of a stored reason workable:
 * a row settled (`proxyAt` set) with no proxy while this still returns true is
 * a transcode that failed, and a row settled with this returning false is one
 * that was never wanted. Neither needs a column — the same argument
 * `assetIdsInDoc` makes for walking a document instead of keeping a list.
 */
export function needsProxy(
  a: Pick<AssetRecord, 'kind' | 'width' | 'height' | 'bytes'>,
): boolean {
  if (a.kind !== 'video') return false
  // Nothing measured means nothing to scale to. An unprobed file is not
  // refused here so much as not yet askable.
  if (!a.width || !a.height) return false
  return a.height > PROXY.maxHeight || a.bytes > PROXY.maxDirectBytes
}

/** Round to an even number — H.264 cannot encode an odd dimension in yuv420p. */
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

/**
 * Proxy dimensions for a source, computed rather than left to an ffmpeg
 * expression so they are testable without spawning anything — the same split
 * `buildFfmpegArgs` makes for the mux.
 *
 * **Scales down only.** A file that qualifies on bytes alone (long, or a high
 * bitrate at a modest size) keeps its dimensions and gains the re-encode; a
 * proxy that upscaled would be larger than the thing it stands in for.
 */
export function proxySize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, PROXY.maxHeight / height)
  return { width: even(width * scale), height: even(height * scale) }
}

/** One line of measured facts about a file, for a listing. */
export function describeMedia(a: AssetRecord): string {
  const bits: string[] = []
  if (a.width && a.height) bits.push(`${a.width}x${a.height}`)
  if (a.durationSec) bits.push(`${a.durationSec.toFixed(2)}s`)
  if (a.fps) bits.push(`${Math.round(a.fps)}fps`)
  // The proxy affects how a file behaves in the editor and nothing about how it
  // exports, so it is reported as a property of the file rather than as a
  // status somebody has to go and look up.
  if (a.probedAt && needsProxy(a)) {
    const size = a.width && a.height ? proxySize(a.width, a.height) : null
    if (a.proxyBytes && size) bits.push(`proxy ${size.width}x${size.height}`)
    else if (!a.proxyAt) bits.push('proxy pending')
    else bits.push('no proxy (transcode failed)')
  }
  // "not probed yet" is worth saying: a clip with no duration cannot be placed
  // on a lane, and the reason is timing rather than a broken file.
  if (bits.length === 0 && a.kind !== 'model' && !a.probedAt) return 'not measured yet'
  return bits.join(' ')
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
 * What a user is allowed to upload, and which `kind` each type counts as.
 *
 * An allowlist rather than a sniff: uploads are the only route media takes
 * into a project, and "whatever the browser said" is not a decision. Anything
 * absent here is refused with its own type named, which is more useful than a
 * generic rejection when someone drags in a `.mov` the browser labelled
 * `video/quicktime`.
 */
export const UPLOADABLE_MIMES: Record<string, string> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/ogg': 'audio',
  'audio/flac': 'audio',
  'model/gltf-binary': 'model',
}

/** The asset `kind` for an uploaded mime, or null when it is not allowed. */
export function uploadKindFor(mime: string): string | null {
  return UPLOADABLE_MIMES[mime.split(';')[0]!.trim().toLowerCase()] ?? null
}

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
 * write the row only after the bytes land.
 *
 * **Found by walking, not by listing.** This used to check
 * `scene.narration.audio.assetId` and nothing else, with a comment asking
 * callers to treat it as "ask the document". Then audio tracks arrived with an
 * `assetId` on every clip, and a file playing on the timeline read as *unused*
 * — `list_assets` offered it for deletion and `remove_asset` would have taken
 * the bytes out from under it. An enumerated list has to be revised by whoever
 * adds a reference, and that is exactly what does not happen.
 *
 * A deep walk cannot go stale: any `assetId` anywhere in the document is a
 * reference by definition, so narration, audio clips, and the image and video
 * nodes still to come are all covered without this function being touched.
 */
export function assetIdsInDoc(doc: EuclidDoc): Set<string> {
  const ids = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'assetId' && typeof child === 'string' && child) ids.add(child)
      else walk(child)
    }
  }
  walk(doc)
  return ids
}
