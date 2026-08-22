import {
  assetIdsInDoc,
  defaultAssetPath,
  normalizeAssetPath,
  type AssetRecord,
} from '@euclid/dsl'
import { AccessError, docOf, mayAccess, requireProjectAccess } from '../shared'
import type { Env } from '../env'

export interface AssetRow {
  id: string
  /** The owner (plans/010 phase 4). Null only on rows predating the column. */
  user_id: string | null
  /** The home project — where the file was created. Membership is in project_assets. */
  project_id: string
  kind: string
  r2_key: string
  mime: string
  bytes: number
  duration_sec: number | null
  path: string | null
  created_at: number
  width: number | null
  height: number | null
  fps: number | null
  probed_at: number | null
  shots: string | null
  shots_at: number | null
  proxy_key: string | null
  proxy_bytes: number | null
  proxy_at: number | null
  review_status: string
  review_note: string | null
  reviewed_at: number | null
  reviewed_via: string | null
  revises: string | null
  tts_hash: string | null
}

export const ASSET_KINDS = ['audio', 'video', 'image', 'model']

/**
 * Suffix a path until it is free, so a regenerated narration clip sits beside
 * the old one instead of colliding with it (the explorer is what finally makes
 * those leftovers visible). Paths are per *link* — the same file may sit at
 * different paths in different projects — so the clash check reads the links.
 */
async function uniqueAssetPath(env: Env, projectId: string, wanted: string): Promise<string> {
  const dot = wanted.lastIndexOf('.')
  const stem = dot > wanted.lastIndexOf('/') ? wanted.slice(0, dot) : wanted
  const ext = dot > wanted.lastIndexOf('/') ? wanted.slice(dot) : ''
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? wanted : `${stem}-${n + 1}${ext}`
    const clash = await env.DB.prepare(
      'SELECT asset_id FROM project_assets WHERE project_id = ? AND path = ?',
    )
      .bind(projectId, candidate)
      .first<{ asset_id: string }>()
    if (!clash) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}

/**
 * Shared by the upload route and the in-worker producers (TTS today). The row
 * is written only once the bytes are really in R2, and a zero-byte put is
 * removed before any row exists — a document must never hold an assetId that
 * resolves to nothing.
 */
export async function storeAsset(
  env: Env,
  projectId: string,
  input: {
    kind: string
    mime: string
    durationSec?: number | null
    /** Virtual path; defaults to /<kind>/<id>.<ext> when the caller has no better name. */
    path?: string | null
    body: ReadableStream | ArrayBuffer
    /**
     * Where this file starts with the human (plans/010). Provenance decides:
     * the owner's own uploads and render outputs default to approved; the
     * generating producers pass pending while the project is in review mode.
     * `via: 'auto'` marks an approval nobody clicked (provenance rules).
     */
    review?: {
      status: 'pending' | 'approved'
      via?: 'auto'
      note?: string
      /** The asset this one iterates on — recorded as lineage. */
      revises?: string | null
      /** Narration only: hash of (voiceId, text), for re-synthesis matching. */
      ttsHash?: string | null
    }
  },
): Promise<{ assetId: string; bytes: number; path: string }> {
  const assetId = crypto.randomUUID()
  // The file belongs to the project's OWNER, not to whoever stored it: an
  // internal producer (TTS, fal, the render worker) stores on the owner's
  // behalf, and the owner is what tenancy will check from now on.
  const owner = await env.DB.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>()
  if (!owner) throw new Error('project_not_found')
  const key = `assets/${owner.user_id}/${assetId}`
  const object = await env.ASSETS.put(key, input.body, {
    httpMetadata: { contentType: input.mime },
  })
  if (!object || object.size === 0) {
    await env.ASSETS.delete(key)
    throw new Error('empty_asset_body')
  }
  let path = defaultAssetPath(input.kind, input.mime, assetId)
  if (input.path) {
    try {
      path = await uniqueAssetPath(env, projectId, normalizeAssetPath(input.path))
    } catch {
      // A bad suggested name must not lose the bytes we already stored.
    }
  }
  const review = input.review ?? { status: 'approved' as const }
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO assets (id, user_id, project_id, kind, r2_key, mime, bytes, duration_sec, path, created_at,
                         review_status, review_note, reviewed_at, reviewed_via, revises, tts_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      assetId,
      owner.user_id,
      projectId,
      input.kind,
      key,
      input.mime,
      object.size,
      input.durationSec ?? null,
      path,
      now,
      review.status,
      review.note ?? null,
      review.status === 'approved' ? now : null,
      review.status === 'approved' ? (review.via ?? 'auto') : null,
      review.revises ?? null,
      review.ttsHash ?? null,
    )
    .run()
  // Membership: the home project links what it creates.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO project_assets (project_id, asset_id, path, linked_at) VALUES (?, ?, ?, ?)',
  )
    .bind(projectId, assetId, path, now)
    .run()
  return { assetId, bytes: object.size, path }
}

/** R2 keys that finished render jobs still hand out download URLs for. */
export async function renderOutputKeys(env: Env, projectId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    'SELECT output_key FROM render_jobs WHERE project_id = ? AND output_key IS NOT NULL',
  )
    .bind(projectId)
    .all<{ output_key: string }>()
  return new Set(rows.results.map((r) => r.output_key))
}

/**
 * Owner-or-internal lookup shared by the asset routes.
 *
 * The owner is the asset's own `user_id` since plans/010 phase 4 — which also
 * frees an asset from its home project: a file linked into another project
 * serves there under exactly the same rule. The LEFT JOIN survives only as
 * the COALESCE fallback for rows created before the column existed (and it
 * keeps working after the home project is deleted, when the join finds
 * nothing but `user_id` still answers).
 */
export async function loadAsset(env: Env, assetId: string) {
  return env.DB.prepare(
    `SELECT a.*, COALESCE(a.user_id, p.user_id) AS owner FROM assets a
     LEFT JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  )
    .bind(assetId)
    .first<AssetRow & { owner: string | null }>()
}

/**
 * An asset's gate: {@link mayAccess} against the owner, the same rule every
 * other route applies. Exported because the read route needs it too.
 */
export async function requireAsset(env: Env, assetId: string, userId: string) {
  const asset = await loadAsset(env, assetId)
  if (!asset) throw new AccessError(`asset ${assetId} not found`, 404)
  if (!asset.owner || !mayAccess(asset.owner, userId)) throw new AccessError('forbidden', 403)
  return asset as AssetRow & { owner: string }
}

/**
 * A project's files. `path` is a virtual path — folders are derived from it,
 * never stored — so the editor and the agent surface build the same tree from
 * these rows with `buildAssetTree`.
 *
 * `usedBy` marks assets the document depends on, which is what makes deletion
 * refusable rather than silently breaking a scene.
 */
function toRecord(r: AssetRow, path: string): AssetRecord {
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    bytes: r.bytes,
    durationSec: r.duration_sec,
    path,
    createdAt: r.created_at,
    width: r.width,
    height: r.height,
    fps: r.fps,
    probedAt: r.probed_at,
    shots: r.shots ? (JSON.parse(r.shots) as number[]) : null,
    shotsAt: r.shots_at,
    // `proxy_key` deliberately stays out of the record: which R2 object serves
    // a scrub is the API's decision, and a client that knew the key could ask
    // for the wrong bytes.
    proxyBytes: r.proxy_bytes,
    proxyAt: r.proxy_at,
    reviewStatus: r.review_status,
    reviewNote: r.review_note,
    revises: r.revises,
  } as AssetRecord
}

/**
 * A project's files are now its **links** (plans/010 phase 4): the rows come
 * from `project_assets`, so a library asset linked in from another project
 * lists here exactly like a file born here, under this project's path for it.
 */
export async function listProjectAssets(
  env: Env,
  projectId: string,
  userId: string,
): Promise<(AssetRecord & { usedBy: boolean })[]> {
  await requireProjectAccess(env, projectId, userId)
  const rows = await env.DB.prepare(
    `SELECT a.*, pa.path AS link_path
     FROM project_assets pa JOIN assets a ON a.id = pa.asset_id
     WHERE pa.project_id = ? ORDER BY a.created_at`,
  )
    .bind(projectId)
    .all<AssetRow & { link_path: string | null }>()

  const doc = await docOf(env, projectId)
  const used = doc ? assetIdsInDoc(doc) : new Set<string>()
  // A render output is not referenced by the *document* but is very much in
  // use — its job hands out a download URL for it. Without this every render
  // would read as "unused", which is exactly the wrong nudge.
  const renderKeys = await renderOutputKeys(env, projectId)

  return rows.results.map((r) => ({
    // The link's path wins; the asset's own path (its home-project view) and
    // the derived default remain the fallbacks older rows resolve through.
    ...toRecord(r, r.link_path || r.path || defaultAssetPath(r.kind, r.mime, r.id)),
    usedBy: used.has(r.id) || renderKeys.has(r.r2_key),
  }))
}

/**
 * Everything the user owns, across all their projects — the library. Each
 * record carries how many projects link it and whether `projectId` (the one
 * the caller is looking from) already does.
 */
export async function listLibraryAssets(
  env: Env,
  userId: string,
  projectId?: string,
): Promise<(AssetRecord & { links: number; linkedHere: boolean })[]> {
  const rows = await env.DB.prepare(
    `SELECT a.*,
            (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_id = a.id) AS links,
            (SELECT COUNT(*) FROM project_assets pa WHERE pa.asset_id = a.id AND pa.project_id = ?) AS here
     FROM assets a WHERE a.user_id = ? ORDER BY a.created_at DESC`,
  )
    .bind(projectId ?? '', userId)
    .all<AssetRow & { links: number; here: number }>()
  return rows.results.map((r) => ({
    ...toRecord(r, r.path || defaultAssetPath(r.kind, r.mime, r.id)),
    links: r.links,
    linkedHere: r.here > 0,
  }))
}

/**
 * Put an existing asset into a project — a link, never a copy. The asset must
 * belong to the project's owner: even an internal caller cannot join one
 * user's file to another user's project.
 */
export async function linkAsset(
  env: Env,
  projectId: string,
  assetId: string,
  userId: string,
  wantedPath?: string,
): Promise<{ assetId: string; path: string; already: boolean }> {
  await requireProjectAccess(env, projectId, userId)
  const asset = await requireAsset(env, assetId, userId)
  const project = await env.DB.prepare('SELECT user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ user_id: string }>()
  if (!project || asset.owner !== project.user_id) {
    throw new AccessError('asset and project belong to different users', 403)
  }
  const existing = await env.DB.prepare(
    'SELECT path FROM project_assets WHERE project_id = ? AND asset_id = ?',
  )
    .bind(projectId, assetId)
    .first<{ path: string | null }>()
  if (existing) {
    return { assetId, path: existing.path ?? asset.path ?? '', already: true }
  }
  const path = await uniqueAssetPath(
    env,
    projectId,
    normalizeAssetPath(wantedPath ?? asset.path ?? defaultAssetPath(asset.kind, asset.mime, assetId)),
  )
  await env.DB.prepare(
    'INSERT INTO project_assets (project_id, asset_id, path, linked_at) VALUES (?, ?, ?, ?)',
  )
    .bind(projectId, assetId, path, Date.now())
    .run()
  return { assetId, path, already: false }
}

/**
 * Take an asset out of a project. Never touches bytes — the file stays in the
 * library and in every other project that links it. Refused while this
 * project's document still references it, for the invariant deleteAsset
 * keeps: a document must never hold an assetId that resolves to nothing *for
 * it*.
 */
export async function unlinkAsset(
  env: Env,
  projectId: string,
  assetId: string,
  userId: string,
): Promise<{ assetId: string; remainingLinks: number }> {
  await requireProjectAccess(env, projectId, userId)
  await requireAsset(env, assetId, userId)
  const doc = await docOf(env, projectId)
  if (doc && assetIdsInDoc(doc).has(assetId)) {
    const scenes = doc.scenes
      .filter((s) => s.narration?.audio?.assetId === assetId)
      .map((s) => `narration in "${s.name}"`)
    throw new AssetInUse(assetId, scenes.length ? scenes : ['the document'], false)
  }
  await env.DB.prepare('DELETE FROM project_assets WHERE project_id = ? AND asset_id = ?')
    .bind(projectId, assetId)
    .run()
  const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_assets WHERE asset_id = ?')
    .bind(assetId)
    .first<{ n: number }>()
  return { assetId, remainingLinks: left?.n ?? 0 }
}

/** Which projects link an asset, by name — for refusals that must say where. */
export async function linkedProjects(
  env: Env,
  assetId: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await env.DB.prepare(
    `SELECT p.id, p.name FROM project_assets pa
     JOIN projects p ON p.id = pa.project_id WHERE pa.asset_id = ?`,
  )
    .bind(assetId)
    .all<{ id: string; name: string }>()
  return rows.results
}

export class AssetPathTaken extends Error {
  constructor(readonly path: string, readonly assetId: string) {
    super(`path ${path} is already used by ${assetId}`)
  }
}

/**
 * Rename or move — a new virtual path, on the **link**: the same file may sit
 * at different paths in different projects, so the rename names which
 * project's view it changes (defaulting to the home project). The asset's own
 * `path` follows when it is the home view, keeping the fallback truthful.
 */
export async function moveAsset(
  env: Env,
  assetId: string,
  wanted: string,
  userId: string,
  projectId?: string,
): Promise<{ assetId: string; path: string }> {
  const asset = await requireAsset(env, assetId, userId)
  const inProject = projectId ?? asset.project_id
  const path = normalizeAssetPath(wanted) // throws AssetPathError on traversal
  // Two files sharing a path would render an ambiguous tree.
  const clash = await env.DB.prepare(
    'SELECT asset_id FROM project_assets WHERE project_id = ? AND path = ? AND asset_id != ?',
  )
    .bind(inProject, path, asset.id)
    .first<{ asset_id: string }>()
  if (clash) throw new AssetPathTaken(path, clash.asset_id)

  await env.DB.prepare('UPDATE project_assets SET path = ? WHERE project_id = ? AND asset_id = ?')
    .bind(path, inProject, asset.id)
    .run()
  if (inProject === asset.project_id) {
    await env.DB.prepare('UPDATE assets SET path = ? WHERE id = ?').bind(path, asset.id).run()
  }
  return { assetId: asset.id, path }
}

export class AssetInUse extends Error {
  constructor(
    readonly assetId: string,
    /** Where the references are, in words — narration, timeline clips. */
    readonly scenes: string[],
    readonly isRenderOutput: boolean,
  ) {
    super(`asset ${assetId} is still in use`)
  }
}

export class AssetLinkedElsewhere extends Error {
  constructor(
    readonly assetId: string,
    /** The other projects still linking it, by name. */
    readonly projects: { id: string; name: string }[],
  ) {
    super(`asset ${assetId} is linked in other projects`)
  }
}

/**
 * Delete the file itself — bytes, links, row.
 *
 * Two guards, two remedies. Links from **other** projects refuse outright
 * (no force): those projects still show the file, and the remedy is to
 * unlink it there first — deleting under them would be delete_project's
 * irreversibility without its ceremony. A reference from a **document**
 * refuses with the scenes named, and `force` is the deliberate override
 * that accepts the broken reference — unchanged from phase 2, now checked
 * across every linked project's document rather than one.
 */
export async function deleteAsset(
  env: Env,
  assetId: string,
  force: boolean,
  userId: string,
  /** The project the caller is deleting from; links elsewhere are the refusal. */
  fromProjectId?: string,
): Promise<{ deleted: string; wasInUse: boolean }> {
  const asset = await requireAsset(env, assetId, userId)
  const links = await linkedProjects(env, assetId)
  const context = fromProjectId ?? asset.project_id

  const elsewhere = links.filter((p) => p.id !== context)
  if (elsewhere.length > 0) throw new AssetLinkedElsewhere(assetId, elsewhere)

  let inUse = false
  const where: string[] = []
  for (const link of links) {
    const doc = await docOf(env, link.id)
    if (!doc || !assetIdsInDoc(doc).has(asset.id)) continue
    inUse = true
    // Name the places, not just the fact. A refusal reading "used by: the
    // document" is true and useless — the caller still has to go looking.
    where.push(
      ...doc.scenes
        .filter((s) => s.narration?.audio?.assetId === asset.id)
        .map((s) => `narration in "${s.name}"`),
      ...(doc.audio ?? []).flatMap((track) =>
        track.clips
          .filter((c) => c.assetId === asset.id)
          .map((c) => `a clip on "${track.name}" at ${c.startSec}s`),
      ),
    )
  }
  const renderKeys = await renderOutputKeys(env, asset.project_id)
  const isRenderOutput = renderKeys.has(asset.r2_key)
  inUse = inUse || isRenderOutput

  if (inUse && !force) throw new AssetInUse(asset.id, where, isRenderOutput)

  await env.ASSETS.delete(asset.r2_key)
  // The proxy is a second object under the same row, so deleting the row
  // without it leaves bytes nothing can ever name again.
  if (asset.proxy_key) await env.ASSETS.delete(asset.proxy_key)
  await env.DB.prepare('DELETE FROM project_assets WHERE asset_id = ?').bind(asset.id).run()
  await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(asset.id).run()
  // Don't leave a job advertising a download that now 410s.
  if (isRenderOutput) {
    await env.DB.prepare('UPDATE render_jobs SET output_key = NULL WHERE output_key = ?')
      .bind(asset.r2_key)
      .run()
  }
  return { deleted: asset.id, wasInUse: inUse }
}
