import { useEffect, useState } from 'react'
import { assetBasename } from '@euclid/dsl'
import { assetUrl, formatBytes, type ProjectFile } from './useAssets'

/**
 * Inline viewers for everything a project can hold.
 *
 * The explorer made files *visible*; this makes them *openable*. Before it,
 * the only way to see a generated image or a 3D model was `↗` into a browser
 * tab, which loses the editor — and for a `.glb` even that shows nothing.
 *
 * One rule decides the design: **the viewer never guesses from the extension
 * alone.** `mime` is what the producer recorded and what the API serves the
 * bytes back as, so it leads; the path's extension is only a fallback for rows
 * stored as `application/octet-stream`.
 */
export type ViewerKind = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'model' | 'binary'

const TEXT_EXT = new Set([
  'txt', 'md', 'json', 'csv', 'tsv', 'srt', 'vtt', 'log', 'xml', 'svg', 'yml', 'yaml',
  'js', 'ts', 'tsx', 'jsx', 'css', 'html', 'py', 'sh',
])

/** How big a text file we will pull into the DOM before truncating. */
const TEXT_LIMIT = 512 * 1024
/** How much of a GLB we read to find its JSON chunk — which the spec puts first. */
const MODEL_PROBE = 4 * 1024 * 1024
const MAX_LINES = 4000

export function viewerKind(mime: string, path: string): ViewerKind {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (mime.startsWith('model/') || ext === 'glb' || ext === 'gltf') return 'model'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (mime.startsWith('text/') || /\+(json|xml)$/.test(mime)) return 'text'
  if (mime === 'application/json' || mime === 'application/xml') return 'text'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'binary'
}

/** One glyph per kind, so a tree scans as fast as a VS Code explorer does. */
export function fileGlyph(file: ProjectFile): string {
  switch (viewerKind(file.mime, file.path)) {
    case 'image':
      return '▣'
    case 'video':
      return '▶'
    case 'audio':
      return '♪'
    case 'model':
      return '◈'
    case 'text':
      return '≡'
    case 'pdf':
      return '¶'
    default:
      return '○'
  }
}

export function FileViewer({ file }: { file: ProjectFile }) {
  const url = assetUrl(file.id)
  const kind = viewerKind(file.mime, file.path)
  // Pixel dimensions are only known once the image decodes, and they belong
  // with the other facts about the file rather than floating over it.
  const [dims, setDims] = useState<string | null>(null)

  return (
    <div className="file-view">
      <div className="file-view-head">
        <span className="file-view-path" title={file.path}>
          {file.path}
        </span>
        <span className="file-view-meta">
          {file.mime} · {formatBytes(file.bytes)}
          {dims ? ` · ${dims}` : ''}
          {file.durationSec ? ` · ${file.durationSec.toFixed(2)}s` : ''}
          {file.usedBy ? ' · in use' : ''}
        </span>
        <span className="grow" />
        <a href={url} target="_blank" rel="noreferrer" title="open in a browser tab">
          ↗ open
        </a>
        <a href={url} download={assetBasename(file.path)} title="download">
          ↓ save
        </a>
      </div>
      <div className={`file-view-body${kind === 'text' || kind === 'model' ? ' scroll' : ''}`}>
        {kind === 'image' && <ImageView url={url} onDims={setDims} />}
        {kind === 'video' && <video className="media" src={url} controls playsInline />}
        {kind === 'audio' && (
          <div className="audio-view">
            <audio src={url} controls />
            <span className="muted">{assetBasename(file.path)}</span>
          </div>
        )}
        {kind === 'text' && <TextView url={url} bytes={file.bytes} />}
        {kind === 'pdf' && <iframe className="pdf-view" src={url} title={file.path} />}
        {kind === 'model' && <ModelView url={url} mime={file.mime} path={file.path} />}
        {kind === 'binary' && (
          <p className="muted center">
            No inline viewer for <code>{file.mime}</code>. The bytes are there — open or save them
            above.
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Images sit on a checkerboard: a generated PNG with an alpha channel is
 * otherwise indistinguishable from one with a black background, and which of
 * those it is decides whether it can be composited over a scene.
 *
 * The image is *contained*, never cropped and never overflowing — a 1024²
 * generation and a 4K frame must both read as "this is the whole picture".
 */
function ImageView({ url, onDims }: { url: string; onDims: (d: string) => void }) {
  return (
    <div className="image-view">
      <img
        src={url}
        alt=""
        onLoad={(e) => onDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
      />
    </div>
  )
}

/**
 * Text, with a gutter. Ranged so a huge file cannot wedge the tab — the API is
 * range-aware for the same reason narration audio is seekable.
 */
function TextView({ url, bytes }: { url: string; bytes: number }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const truncated = bytes > TEXT_LIMIT

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: truncated ? { Range: `bytes=0-${TEXT_LIMIT - 1}` } : {},
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const body = await res.text()
        if (!cancelled) setText(body)
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url, truncated])

  if (error) return <p className="muted center">could not read this file: {error}</p>
  if (text === null) return <p className="muted center">loading…</p>

  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_LINES)

  return (
    <div className="text-file">
      <div className="text-gutter">
        {shown.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <pre className="text-code">{shown.join('\n')}</pre>
      {(truncated || lines.length > MAX_LINES) && (
        <div className="text-truncated">
          showing the first {truncated ? `${formatBytes(TEXT_LIMIT)} of ` : ''}
          {Math.min(lines.length, MAX_LINES)} lines — open or save the file for the rest
        </div>
      )}
    </div>
  )
}

interface GltfSummary {
  generator?: string
  meshes: number
  primitives: number
  /** null when an accessor a primitive names is missing — better than a wrong count. */
  triangles: number | null
  materials: number
  images: number
  animations: number
  nodes: number
}

/**
 * A GLB/glTF **structure** view, not a render.
 *
 * Being honest about that is the point: the engine's mesh node takes
 * parametric geometry (`{kind:'sphere', radius, segments}`), not imported
 * vertices, so nothing in this codebase can draw a downloaded model — see
 * plans/009. What a file explorer *can* usefully answer without a WebGL
 * dependency is the question that plan's own table asks about every
 * generation: how many triangles did we get, and does it carry materials?
 */
function ModelView({ url, mime, path }: { url: string; mime: string; path: string }) {
  const [summary, setSummary] = useState<GltfSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isJson = mime === 'model/gltf+json' || path.toLowerCase().endsWith('.gltf')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: isJson ? {} : { Range: `bytes=0-${MODEL_PROBE - 1}` },
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const json = isJson ? await res.json() : gltfJsonFromGlb(await res.arrayBuffer())
        if (!cancelled) setSummary(summarizeGltf(json as Record<string, unknown>))
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [url, isJson])

  if (error) return <p className="muted center">could not read this model: {error}</p>
  if (!summary) return <p className="muted center">reading model…</p>

  return (
    <div className="model-view">
      <h4>{isJson ? 'glTF' : 'GLB'} contents</h4>
      <dl className="model-facts">
        <dt>triangles</dt>
        <dd>{summary.triangles === null ? 'unknown' : summary.triangles.toLocaleString()}</dd>
        <dt>meshes</dt>
        <dd>
          {summary.meshes} ({summary.primitives} primitive{summary.primitives === 1 ? '' : 's'})
        </dd>
        <dt>nodes</dt>
        <dd>{summary.nodes}</dd>
        <dt>materials</dt>
        <dd>{summary.materials}</dd>
        <dt>textures</dt>
        <dd>{summary.images}</dd>
        <dt>animations</dt>
        <dd>{summary.animations}</dd>
        {summary.generator && (
          <>
            <dt>generator</dt>
            <dd>{summary.generator}</dd>
          </>
        )}
      </dl>
      <p className="muted model-note">
        Structure only — the engine draws parametric mesh solids, not imported vertices, so there is
        nothing here that can put this file on the canvas yet.
      </p>
    </div>
  )
}

/**
 * The JSON chunk of a binary glTF. The spec fixes a 12-byte header and puts
 * the JSON chunk first, so a ranged read of the head is enough — we never pull
 * a 7.7MB model into the tab to answer "how many triangles".
 */
function gltfJsonFromGlb(buf: ArrayBuffer): unknown {
  const dv = new DataView(buf)
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) {
    throw new Error('not a GLB file (bad magic)')
  }
  let off = 12
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true)
    const type = dv.getUint32(off + 4, true)
    if (type === 0x4e4f534a) {
      if (off + 8 + len > buf.byteLength) throw new Error('metadata larger than the 4MB probe')
      return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len)))
    }
    off += 8 + len
  }
  throw new Error('no JSON chunk')
}

function summarizeGltf(json: Record<string, any>): GltfSummary {
  const meshes: any[] = json.meshes ?? []
  const accessors: any[] = json.accessors ?? []
  let primitives = 0
  let triangles: number | null = 0

  for (const mesh of meshes) {
    for (const p of mesh.primitives ?? []) {
      primitives++
      // mode 4 is TRIANGLES and is the default; lines and points have no
      // triangles to count, so they contribute nothing rather than nonsense.
      if ((p.mode ?? 4) !== 4) continue
      const index = p.indices ?? p.attributes?.POSITION
      const count = accessors[index]?.count
      if (typeof count !== 'number') {
        triangles = null
        continue
      }
      if (triangles !== null) triangles += Math.floor(count / 3)
    }
  }

  return {
    generator: json.asset?.generator,
    meshes: meshes.length,
    primitives,
    triangles,
    materials: (json.materials ?? []).length,
    images: (json.images ?? []).length,
    animations: (json.animations ?? []).length,
    nodes: (json.nodes ?? []).length,
  }
}
