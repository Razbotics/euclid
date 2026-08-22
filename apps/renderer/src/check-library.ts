/**
 * The asset library — user-owned assets, project links (plans/010, phase 4).
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-library.ts
 *
 * Needs `dev:api`. **Spends nothing** — every asset here is an uploaded
 * 1×1 PNG, and nothing renders or generates.
 *
 * What is proved, in order: an upload is owned by the user and linked to its
 * home project; the library scope sees it from any of their projects; linking
 * shares it (a link, never a copy) under a per-project path; placement into a
 * third project links automatically; a foreign user is refused throughout;
 * renaming one project's view leaves the others' alone; deleting the HOME
 * project keeps the file (bytes and all) because other links protect it, and
 * says so in its report; deleting the file is refused while other projects
 * link it, unlinking is refused while a document references it, and once the
 * last link stands alone the delete finally lands.
 */
import './load-env'
import assert from 'node:assert'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }

const run = async (name: string, args: Record<string, unknown>, user = 'dev-user') => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json`, {
    method: 'POST',
    headers: { ...H, 'x-user-id': user },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await run(name, args)
  assert.equal(r.status, 200, `${name} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any }
}
const balance = async (): Promise<number> => {
  const res = await fetch(`${API}/api/billing/balance`, { headers: H })
  return ((await res.json()) as { balance: number }).balance
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const startBalance = await balance()

const [a, b, c] = await Promise.all([
  ok('create_project', { name: 'lib-A' }),
  ok('create_project', { name: 'lib-B' }),
  ok('create_project', { name: 'lib-C' }),
])
const A = a.data.id as string
const B = b.data.id as string
const C = c.data.id as string

// ---------- 1. an upload is user-owned, home-linked, approved ----------
const up = await fetch(`${API}/api/projects/${A}/assets?kind=image&name=dot.png`, {
  method: 'POST',
  headers: { ...H, 'content-type': 'image/png' },
  body: PNG,
})
const upBody = await up.text()
assert.equal(up.status, 200, upBody)
const assetId = (JSON.parse(upBody) as { assetId: string }).assetId

const inA = await ok('list_assets', { projectId: A })
assert.match(inA.text, /dot\.png/, inA.text)

// ---------- 2. the library sees it from another project ----------
const libFromB = await ok('list_assets', { projectId: B, scope: 'library' })
const entry = (libFromB.data.assets as any[]).find((x) => x.id === assetId)
assert.ok(entry, `the library must list the upload: ${libFromB.text}`)
assert.equal(entry.links, 1, 'one link — its home project')
assert.equal(entry.linkedHere, false, 'B does not link it yet')

// ---------- 3. linking shares under a per-project path; idempotent ----------
const linked = await ok('link_asset', { projectId: B, assetId, path: '/refs/logo.png' })
assert.match(linked.text, /linked .* as \/refs\/logo\.png/, linked.text)
const again = await ok('link_asset', { projectId: B, assetId })
assert.match(again.text, /already linked/, again.text)
const inB = await ok('list_assets', { projectId: B })
assert.match(inB.text, /refs\//, `B sees its own path for the file: ${inB.text}`)

// ---------- 4. placement into a third project links automatically ----------
const scene = await ok('add_scene', { projectId: C, name: 'Card', duration: 3 })
const img = await ok('add_image', {
  projectId: C,
  sceneId: scene.data.sceneId,
  assetId,
  x: 100,
  y: 100,
  width: 120,
  height: 120,
})
assert.match(img.text, /linked into this project/, img.text)
const inC = await ok('list_assets', { projectId: C })
assert.match(inC.text, /dot\.png.*\[in use\]/s, inC.text)

// ---------- 5. a foreign user is refused throughout ----------
const foreignRead = await fetch(`${API}/api/assets/${assetId}`, {
  headers: { ...H, 'x-user-id': 'intruder' },
})
assert.equal(foreignRead.status, 403, 'a foreign user must not read the bytes')
const foreignLink = await run('link_asset', { projectId: B, assetId }, 'intruder')
assert.equal(foreignLink.status, 403, `nor link it: ${foreignLink.body}`)

// ---------- 6. renaming one project's view leaves the others' alone ----------
await ok('move_asset', { projectId: B, assetId, path: '/branding/logo.png' })
const inB2 = await ok('list_assets', { projectId: B })
assert.match(inB2.text, /branding\//, inB2.text)
const inA2 = await ok('list_assets', { projectId: A })
assert.match(inA2.text, /dot\.png/, `A's view must be untouched: ${inA2.text}`)

// ---------- 7. deleting the HOME project keeps a file linked elsewhere ----------
const gone = await ok('delete_project', { projectId: A, confirm: true })
assert.equal(gone.data.assetsLinkedElsewhere, 1, JSON.stringify(gone.data))
const stillThere = await fetch(`${API}/api/assets/${assetId}`, { headers: H })
assert.equal(stillThere.status, 200, 'the bytes must survive their home project')
const inB3 = await ok('list_assets', { projectId: B })
assert.match(inB3.text, /branding\//, `B must still see it: ${inB3.text}`)

// ---------- 8. delete refused while linked elsewhere; unlink while in use ----------
const refuse = await run('remove_asset', { projectId: B, assetId })
assert.equal(refuse.status, 409, `delete must refuse while C links it: ${refuse.body}`)
assert.match(refuse.body, /lib-C/, 'and name the project')
const unlinkInUse = await run('unlink_asset', { projectId: C, assetId })
assert.equal(unlinkInUse.status, 409, `unlink must refuse while C's document uses it: ${unlinkInUse.body}`)
await ok('remove_node', { projectId: C, sceneId: scene.data.sceneId, nodeId: img.data.nodeId })
const unlinked = await ok('unlink_asset', { projectId: C, assetId })
assert.equal(unlinked.data.remainingLinks, 1, unlinked.text)

// ---------- 9. the last link stands alone — now the delete lands ----------
await ok('remove_asset', { projectId: B, assetId })
const deleted = await fetch(`${API}/api/assets/${assetId}`, { headers: H })
assert.equal(deleted.status, 404, 'the file must be gone for good')

await ok('delete_project', { projectId: B, confirm: true })
await ok('delete_project', { projectId: C, confirm: true })
assert.equal(await balance(), startBalance, 'nothing here may cost anything')
console.log(
  'check-library OK — ownership, library scope, link/share, auto-link on placement, foreign ' +
    'refusal, per-project rename, home-delete survival, linked/in-use refusals, last-link delete ' +
    'all verified at zero credits',
)
