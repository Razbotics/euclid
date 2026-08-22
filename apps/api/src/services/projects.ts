import { docDuration } from '@euclid/dsl'
import { docOf, projectStub, requireProjectAccess } from '../shared'
import type { Env } from '../env'

export interface ProjectSummary {
  id: string
  name: string
  created_at: number
}

export async function listProjects(env: Env, userId: string): Promise<ProjectSummary[]> {
  const rows = await env.DB.prepare(
    'SELECT id, name, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(userId)
    .all<ProjectSummary>()
  return rows.results
}

export async function createProject(
  env: Env,
  name: string,
  userId: string,
  canvas?: { width: number; height: number; fps: 30 | 60 },
): Promise<{ id: string; name: string }> {
  const id = crypto.randomUUID()
  const trimmed = name.trim()
  await env.DB.prepare('INSERT INTO projects (id, user_id, name, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, userId, trimmed, Date.now())
    .run()
  await projectStub(env, id).fetch('https://do/init', {
    method: 'POST',
    body: JSON.stringify({ id, name: trimmed, canvas }),
  })
  return { id, name: trimmed }
}

/** What a project holds, so a caller can be told before it is destroyed. */
export interface ProjectContents {
  name: string
  scenes: number
  durationSec: number
  assets: number
  renders: number
  /** Of those assets, how many are linked in other projects and will be KEPT. */
  assetsLinkedElsewhere: number
}

export async function projectContents(env: Env, projectId: string): Promise<ProjectContents> {
  const row = await env.DB.prepare('SELECT name FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ name: string }>()
  const doc = await docOf(env, projectId)
  const counts = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM project_assets WHERE project_id = ?) AS assets,
            (SELECT COUNT(*) FROM render_jobs WHERE project_id = ?) AS renders,
            (SELECT COUNT(*) FROM project_assets pa WHERE pa.project_id = ?
               AND EXISTS (SELECT 1 FROM project_assets q
                           WHERE q.asset_id = pa.asset_id AND q.project_id != ?)) AS kept`,
  )
    .bind(projectId, projectId, projectId, projectId)
    .first<{ assets: number; renders: number; kept: number }>()
  return {
    name: row?.name ?? projectId,
    scenes: doc?.scenes.length ?? 0,
    durationSec: doc ? docDuration(doc) : 0,
    assets: counts?.assets ?? 0,
    renders: counts?.renders ?? 0,
    assetsLinkedElsewhere: counts?.kept ?? 0,
  }
}

export interface DeletedProject extends ProjectContents {
  id: string
  objectsDeleted: number
}

/**
 * Delete a project and everything it owns.
 *
 * Deliberately ordered bytes → rows → document → project. R2 is the only store
 * with no foreign key back to anything, so an object orphaned by a mid-way
 * failure is invisible and unreclaimable; a *row* orphaned the same way is
 * still reachable and can be cleaned up on a retry. So the unrecoverable work
 * happens first, while the rows that would let us find it again still exist.
 *
 * The project row goes last for the same reason: while it exists the deletion
 * is resumable, because ownership can still be checked and the children are
 * still reachable by project_id.
 */
export async function deleteProject(
  env: Env,
  projectId: string,
  userId: string,
): Promise<DeletedProject> {
  await requireProjectAccess(env, projectId, userId)
  const contents = await projectContents(env, projectId)

  // Since assets became user-owned links (plans/010 phase 4), deleting a
  // project deletes its LINKS — and reaps only the assets whose last link
  // this was. A file also linked in another project survives, bytes and all;
  // it merely stops appearing here.
  //
  // Render outputs are registered as assets too and point at the same key,
  // so the set is deduped rather than deleted twice. Both objects per asset:
  // a video's scrubbing proxy is a second key on the same row, and it would
  // otherwise survive its project.
  // One query covers linked rows AND legacy rows that predate the link table
  // (home here, no links anywhere) — a legacy row swept without its R2 keys
  // collected would orphan bytes nothing can ever name again.
  const doomed = await env.DB.prepare(
    `SELECT a.id, a.r2_key, a.proxy_key FROM assets a
     WHERE (a.project_id = ?1
            OR EXISTS (SELECT 1 FROM project_assets pa
                       WHERE pa.asset_id = a.id AND pa.project_id = ?1))
       AND NOT EXISTS (SELECT 1 FROM project_assets q
                       WHERE q.asset_id = a.id AND q.project_id != ?1)`,
  )
    .bind(projectId)
    .all<{ id: string; r2_key: string; proxy_key: string | null }>()
  const outputKeys = await env.DB.prepare(
    'SELECT output_key FROM render_jobs WHERE project_id = ? AND output_key IS NOT NULL',
  )
    .bind(projectId)
    .all<{ output_key: string }>()
  const keys = new Set([
    ...doomed.results.map((r) => r.r2_key),
    ...doomed.results.flatMap((r) => (r.proxy_key ? [r.proxy_key] : [])),
    ...outputKeys.results.map((r) => r.output_key),
  ])
  for (const key of keys) await env.ASSETS.delete(key)

  for (const r of doomed.results) {
    await env.DB.prepare('DELETE FROM assets WHERE id = ?').bind(r.id).run()
  }
  await env.DB.prepare('DELETE FROM project_assets WHERE project_id = ?').bind(projectId).run()
  await env.DB.prepare('DELETE FROM render_jobs WHERE project_id = ?').bind(projectId).run()

  // The document and any decisions live in the Durable Object, which no SQL
  // delete would reach.
  await projectStub(env, projectId).fetch('https://do/destroy', { method: 'POST' })

  await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run()
  return { ...contents, id: projectId, objectsDeleted: keys.size }
}
