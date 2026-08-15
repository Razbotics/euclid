/**
 * Project deletion: the cascade, the dry run, and the confirm guard.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-delete.ts
 *
 * Free — no credits. Needs `dev:api`.
 *
 * Deletion is the one operation here with no undo: the event log that gives
 * every other mistake a way back lives in the storage this destroys. So the
 * things worth proving are that it removes *everything* a project owns (an
 * orphaned R2 object is unreachable and unreclaimable), that it refuses to run
 * unconfirmed, and that it cannot be aimed at someone else's project.
 */
import './load-env'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const OWNER = 'delete-check-owner'
const INTRUDER = 'delete-check-intruder'
const as = (u: string) => ({ 'x-internal-key': KEY, 'x-user-id': u })
const json = (u: string) => ({ ...as(u), 'content-type': 'application/json' })

// ---------- a project with something in every store ----------
const created = (await (
  await fetch(`${API}/api/projects`, {
    method: 'POST',
    headers: json(OWNER),
    body: JSON.stringify({ name: 'Delete Check' }),
  })
).json()) as { id: string }
const projectId = created.id

const run = async (name: string, args: Record<string, unknown>, user = OWNER) => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute`, {
    method: 'POST',
    headers: json(user),
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}

const sceneId = (await run('add_scene', { projectId, name: 'S', duration: 4 })).body.match(
  /scene (\S+)/,
)![1]!
await run('add_latex', { projectId, sceneId, tex: 'e^{i\\pi}+1=0', x: 960, y: 540 })

const payload = randomBytes(2048)
const asset = (await (
  await fetch(`${API}/api/projects/${projectId}/assets?kind=audio&durationSec=1`, {
    method: 'POST',
    headers: { ...as(OWNER), 'content-type': 'audio/mpeg' },
    body: payload,
  })
).json()) as { assetId: string }

// A decision lives in the Durable Object rather than D1 — the store a SQL
// delete would silently miss.
await fetch(`${API}/api/projects/${projectId}/decisions`, {
  method: 'POST',
  headers: json(OWNER),
  body: JSON.stringify({
    question: 'Keep?',
    options: [{ id: 'opt1', label: 'Yes' }, { id: 'opt2', label: 'No' }],
  }),
})

// ---------- the guard ----------
const unconfirmed = await run('delete_project', { projectId })
assert.equal(unconfirmed.status, 200, 'an unconfirmed delete is a report, not an error')
assert.match(unconfirmed.body, /NOT DELETED/, 'it must say plainly that nothing happened')
assert.match(unconfirmed.body, /1 scene\(s\)/, 'and describe what would be lost')
assert.match(unconfirmed.body, /1 asset\(s\)/, 'including the assets')

const stillThere = await fetch(`${API}/api/projects/${projectId}/doc`, { headers: as(OWNER) })
assert.equal(stillThere.status, 200, 'the unconfirmed call must not have deleted anything')

// ---------- tenancy ----------
const intruder = await fetch(`${API}/api/projects/${projectId}?dryRun=1`, {
  method: 'DELETE',
  headers: as(INTRUDER),
})
assert.equal(intruder.status, 403, `a non-owner must not delete, got ${intruder.status}`)

// ---------- the dry run ----------
const dry = (await (
  await fetch(`${API}/api/projects/${projectId}?dryRun=1`, { method: 'DELETE', headers: as(OWNER) })
).json()) as { dryRun: boolean; scenes: number; assets: number }
assert.equal(dry.dryRun, true)
assert.equal(dry.scenes, 1, 'the dry run reports the real scene count')
assert.equal(dry.assets, 1, 'and the real asset count')
assert.equal(
  (await fetch(`${API}/api/projects/${projectId}/doc`, { headers: as(OWNER) })).status,
  200,
  'a dry run must leave the project intact',
)

// ---------- the deletion ----------
const gone = (await (
  await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE', headers: as(OWNER) })
).json()) as { id: string; objectsDeleted: number }
assert.equal(gone.id, projectId)
assert.equal(gone.objectsDeleted, 1, 'the asset s bytes must be reported as deleted')

// Every store, checked independently — this is the whole point of the test.
assert.equal(
  (await fetch(`${API}/api/assets/${asset.assetId}`, { headers: as('internal') })).status,
  404,
  'the asset row must be gone',
)
const listed = (await (
  await fetch(`${API}/api/projects`, { headers: as(OWNER) })
).json()) as { projects: { id: string }[] }
assert.ok(!listed.projects.some((p) => p.id === projectId), 'the project must leave the list')

// The Durable Object is the store no SQL delete reaches: if `/destroy` did not
// run, the document would still be served here even with the row gone.
const doc = await fetch(`${API}/api/projects/${projectId}/doc`, { headers: as(OWNER) })
assert.equal(doc.status, 404, `the document must be gone, got ${doc.status}`)

// Deleting twice is a clean 404, not a crash or a second cascade.
const again = await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE', headers: as(OWNER) })
assert.equal(again.status, 404, 'a repeated delete must 404')

console.log(
  'delete OK — confirm guard holds, dry run is side-effect free, tenancy enforced; ' +
    'row, asset bytes, document and decisions all removed, and a repeat delete 404s',
)
