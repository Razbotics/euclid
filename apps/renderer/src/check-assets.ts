/**
 * Asset registry round-trip against a running API.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-assets.ts
 *
 * Proves the storage layer narration audio depends on: bytes survive the
 * round-trip unchanged, and only the owning user (or an internal caller like
 * the render worker) can read them back.
 */
import './load-env'
import assert from 'node:assert'
import { randomBytes } from 'node:crypto'

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'

/** Internal call acting as `user` — the shape the MCP worker sends. */
const as = (user: string) => ({ 'x-internal-key': KEY, 'x-user-id': user })

/**
 * Read the body only on failure. Passing `await res.text()` as an assert
 * message consumes the body eagerly, so a later .json() throws "Body is
 * unusable" and hides the real status.
 */
async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const OWNER = 'dev-user'
const INTRUDER = 'someone-else'

// A project to own the asset. Created as OWNER so the 403 case is meaningful.
const projectRes = await fetch(`${API_URL}/api/projects`, {
  method: 'POST',
  headers: { ...as(OWNER), 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Asset Check' }),
})
const { id: projectId } = await jsonOrThrow<{ id: string }>(projectRes, 'create project')

// Random bytes, so a byte-identical read-back can't pass by coincidence.
const payload = randomBytes(64 * 1024)

const upload = await fetch(`${API_URL}/api/projects/${projectId}/assets?kind=audio&durationSec=3.018`, {
  method: 'POST',
  headers: { ...as(OWNER), 'content-type': 'audio/mpeg' },
  body: payload,
})
const asset = await jsonOrThrow<{
  assetId: string
  kind: string
  mime: string
  bytes: number
  durationSec: number
}>(upload, 'upload asset')
assert.equal(asset.bytes, payload.byteLength, 'recorded size must match what was sent')
assert.equal(asset.mime, 'audio/mpeg', 'mime comes from content-type')
assert.equal(asset.durationSec, 3.018, 'duration round-trips as a real, not an int')

// 1. Internal read-back (the render worker's path) is byte-identical.
const back = await fetch(`${API_URL}/api/assets/${asset.assetId}`, { headers: as('internal') })
assert.ok(back.ok, `internal fetch failed: ${back.status}`)
assert.equal(back.headers.get('content-type'), 'audio/mpeg', 'stored mime is served back')
const returned = Buffer.from(await back.arrayBuffer())
assert.equal(returned.byteLength, payload.byteLength, 'byte length must survive R2')
assert.ok(returned.equals(payload), 'bytes must be identical, not merely the same length')

// 2. The owning user can read it.
const owner = await fetch(`${API_URL}/api/assets/${asset.assetId}`, { headers: as(OWNER) })
assert.equal(owner.status, 200, 'owner may read their own asset')

// 3. A different user may not — tenancy is enforced through the project join.
const intruder = await fetch(`${API_URL}/api/assets/${asset.assetId}`, { headers: as(INTRUDER) })
assert.equal(intruder.status, 403, `non-owner must get 403, got ${intruder.status}`)

// 4. Unknown asset is a clean 404, not a crash.
const missing = await fetch(`${API_URL}/api/assets/does-not-exist`, { headers: as('internal') })
assert.equal(missing.status, 404, 'unknown asset → 404')

// 5. Creation is internal-only: no key at all must not be able to write.
const anon = await fetch(`${API_URL}/api/projects/${projectId}/assets?kind=audio`, {
  method: 'POST',
  headers: { 'content-type': 'audio/mpeg' },
  body: payload,
})
assert.equal(anon.status, 403, `sessionless upload must be refused, got ${anon.status}`)

// 6. Bad kind is rejected before anything is stored.
const badKind = await fetch(`${API_URL}/api/projects/${projectId}/assets?kind=spreadsheet`, {
  method: 'POST',
  headers: { ...as(OWNER), 'content-type': 'audio/mpeg' },
  body: payload,
})
assert.equal(badKind.status, 400, 'unknown kind → 400')

console.log(
  `assets OK — ${(payload.byteLength / 1024).toFixed(0)}KiB round-tripped byte-identical ` +
    `(asset ${asset.assetId} in project ${projectId}); tenancy, 404 and kind validation enforced`,
)
