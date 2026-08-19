import {
  assetIdsInDoc,
  defaultAssetPath,
  normalizeAssetPath,
  type AssetRecord,
} from '@euclid/dsl'
import { AccessError, docOf, requireProjectAccess } from '../shared'
import type { Env } from '../env'

export interface AssetRow {
  id: string
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
}

export const ASSET_KINDS = ['audio', 'video', 'image', 'model']

/**
 * Suffix a path until it is free, so a regenerated narration clip sits beside
 * the old one instead of colliding with it (the explorer is what finally makes
 * those leftovers visible).
 */
async function uniqueAssetPath(env: Env, projectId: string, wanted: string): Promise<string> {
  const dot = wanted.lastIndexOf('.')
  const stem = dot > wanted.lastIndexOf('/') ? wanted.slice(0, dot) : wanted
  const ext = dot > wanted.lastIndexOf('/') ? wanted.slice(dot) : ''
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? wanted : `${stem}-${n + 1}${ext}`
    const clash = await env.DB.prepare('SELECT id FROM assets WHERE project_id = ? AND path = ?')
      .bind(projectId, candidate)
      .first<{ id: string }>()
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
  },
): Promise<{ assetId: string; bytes: number; path: string }> {
  const assetId = crypto.randomUUID()
  const key = `assets/${projectId}/${assetId}`
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
  await env.DB.prepare(
    `INSERT INTO assets (id, project_id, kind, r2_key, mime, bytes, duration_sec, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(assetId, projectId, input.kind, key, input.mime, object.size, input.durationSec ?? null, path, Date.now())
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

/** Owner-or-internal lookup shared by the asset routes. */
export async function loadAsset(env: Env, assetId: string) {
  return env.DB.prepare(
    `SELECT a.*, p.user_id AS owner FROM assets a
     JOIN projects p ON p.id = a.project_id
     WHERE a.id = ?`,
  )
    .bind(assetId)
    .first<AssetRow & { owner: string }>()
}

async function requireAsset(env: Env, assetId: string, userId: string) {
  const asset = await loadAsset(env, assetId)
  if (!asset) throw new AccessError(`asset ${assetId} not found`, 404)
  if (asset.owner !== userId && userId !== 'internal') throw new AccessError('forbidden', 403)
  return asset
}

/**
 * A project's files. `path` is a virtual path — folders are derived from it,
 * never stored — so the editor and the agent surface build the same tree from
 * these rows with `buildAssetTree`.
 *
 * `usedBy` marks assets the document depends on, which is what makes deletion
 * refusable rather than silently breaking a scene.
 */
export async function listProjectAssets(
  env: Env,
  projectId: string,
  userId: string,
): Promise<(AssetRecord & { usedBy: boolean })[]> {
  await requireProjectAccess(env, projectId, userId)
  const rows = await env.DB.prepare(
    `SELECT id, kind, mime, bytes, duration_sec, path, r2_key, created_at,
            width, height, fps, probed_at
     FROM assets WHERE project_id = ? ORDER BY created_at`,
  )
    .bind(projectId)
    .all<AssetRow>()

  const doc = await docOf(env, projectId)
  const used = doc ? assetIdsInDoc(doc) : new Set<string>()
  // A render output is not referenced by the *document* but is very much in
  // use — its job hands out a download URL for it. Without this every render
  // would read as "unused", which is exactly the wrong nudge.
  const renderKeys = await renderOutputKeys(env, projectId)

  return rows.results.map((r) => ({
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    bytes: r.bytes,
    durationSec: r.duration_sec,
    // Rows predating the path column still resolve to a sensible place.
    path: r.path || defaultAssetPath(r.kind, r.mime, r.id),
    createdAt: r.created_at,
    width: r.width,
    height: r.height,
    fps: r.fps,
    probedAt: r.probed_at,
    usedBy: used.has(r.id) || renderKeys.has(r.r2_key),
  })) as (AssetRecord & { usedBy: boolean })[]
}

export class AssetPathTaken extends Error {
  constructor(readonly path: string, readonly assetId: string) {
    super(`path ${path} is already used by ${assetId}`)
  }
}

/** Rename or move — both are just a new virtual path. */
export async function moveAsset(
  env: Env,
  assetId: string,
  wanted: string,
  userId: string,
): Promise<{ assetId: string; path: string }> {
  const asset = await requireAsset(env, assetId, userId)
  const path = normalizeAssetPath(wanted) // throws AssetPathError on traversal
  // Two files sharing a path would render an ambiguous tree.
  const clash = await env.DB.prepare(
    'SELECT id FROM assets WHERE project_id = ? AND path = ? AND id != ?',
  )
    .bind(asset.project_id, path, asset.id)
    .first<{ id: string }>()
  if (clash) throw new AssetPathTaken(path, clash.id)

  await env.DB.prepare('UPDATE assets SET path = ? WHERE id = ?').bind(path, asset.id).run()
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

/**
 * Delete, unless the document still points at it.
 *
 * Phase 2 established that a document must never hold an assetId resolving to
 * nothing; that invariant is worth as much on the way out as on the way in.
 * `force` is the deliberate override, and it reports what it broke.
 */
export async function deleteAsset(
  env: Env,
  assetId: string,
  force: boolean,
  userId: string,
): Promise<{ deleted: string; wasInUse: boolean }> {
  const asset = await requireAsset(env, assetId, userId)

  const doc = await docOf(env, asset.project_id)
  const used = doc ? assetIdsInDoc(doc) : new Set<string>()
  const renderKeys = await renderOutputKeys(env, asset.project_id)
  const isRenderOutput = renderKeys.has(asset.r2_key)
  const inUse = used.has(asset.id) || isRenderOutput

  if (inUse && !force) {
    // Name the places, not just the fact. A refusal reading "used by: the
    // document" is true and useless — the caller still has to go looking.
    const where = [
      ...(doc?.scenes ?? [])
        .filter((s) => s.narration?.audio?.assetId === asset.id)
        .map((s) => `narration in "${s.name}"`),
      ...(doc?.audio ?? []).flatMap((track) =>
        track.clips
          .filter((c) => c.assetId === asset.id)
          .map((c) => `a clip on "${track.name}" at ${c.startSec}s`),
      ),
    ]
    throw new AssetInUse(asset.id, where, isRenderOutput)
  }

  await env.ASSETS.delete(asset.r2_key)
  await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(asset.id).run()
  // Don't leave a job advertising a download that now 410s.
  if (isRenderOutput) {
    await env.DB.prepare('UPDATE render_jobs SET output_key = NULL WHERE output_key = ?')
      .bind(asset.r2_key)
      .run()
  }
  return { deleted: asset.id, wasInUse: inUse }
}
