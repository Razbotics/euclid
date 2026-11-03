/**
 * Social ingest and reference-directed video (2026-09-17), everything short of
 * a paid generation.
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-social.ts [postUrl]
 *
 * **Spends 1 SocialCrawl credit** (one post read) and **no Euclid credits**:
 * every generate_video call here is one the capability layer must refuse
 * before fal is contacted, and the balance is asserted unmoved across all of
 * them. The paid half — a real seedance-2.5-ref render — is too expensive to
 * run per change (~$1+ at 480p) and is run by hand; see docs/recipes.md.
 *
 * Needs `dev:api` with SOCIALCRAWL_API_KEY and FAL_KEY, and `render-worker.ts`
 * (probe and shot detection are its jobs; without it get_shots stays pending).
 */
import './load-env'
import assert from 'node:assert'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const POST = process.argv[2] ?? 'https://www.instagram.com/p/DdUB6TMtN1d/'

const run = async (name: string, args: Record<string, unknown>, paid = false) => {
  const res = await fetch(`${API}/api/agent/tools/${name}/execute?format=json${paid ? '&paid=1' : ''}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.text() }
}
const ok = async (name: string, args: Record<string, unknown>, paid = false) => {
  const r = await run(name, args, paid)
  assert.equal(r.status, 200, `${name} failed: ${r.body}`)
  return JSON.parse(r.body) as { text: string; data: any }
}
const balance = async (): Promise<number> =>
  ((await (await fetch(`${API}/api/billing/balance`, { headers: H })).json()) as { balance: number }).balance

const projectId = (await ok('create_project', { name: 'Social Check' })).data.id
// Review mode would refuse every generate_video below for the wrong reason
// (no plan). This script tests the argument rules, so it opts out.
await ok('set_review_mode', { projectId, enabled: false })

// ---------- 1. unsupported links are refused without calling the provider ----------
const vimeo = await run('import_social_video', { projectId, url: 'https://vimeo.com/1' })
assert.equal(vimeo.status, 400, 'a platform this cannot read is refused')
assert.match(vimeo.body, /instagram/, `and the refusal names what is supported: ${vimeo.body}`)

// ---------- 2. a real post lands as a real video asset ----------
const imp = await ok('import_social_video', { projectId, url: POST })
const reel = imp.data.assetId as string
assert.ok(reel, 'the import names its asset')
assert.ok(imp.data.bytes > 100_000, `an imported video is not tiny (${imp.data.bytes} bytes)`)
const file = await fetch(`${API}/api/assets/${reel}`, { headers: H })
const head = Buffer.from(await file.arrayBuffer()).subarray(4, 8).toString('ascii')
assert.equal(head, 'ftyp', 'the stored bytes are an MP4, not an expired-link error page')
assert.match(imp.text, /get_shots/, 'the response points at the next step')

// ---------- 3. it flows through the same pipeline as an upload ----------
let shots: any
for (let i = 0; i < 60; i++) {
  shots = (await ok('get_shots', { projectId, assetId: reel })).data
  if (!shots.pending) break
  await new Promise((r) => setTimeout(r, 3000))
}
assert.equal(shots.pending, false, 'shot detection must reach an imported file (is render-worker.ts running?)')
assert.ok(shots.segments.length >= 1, 'and produce at least one segment')

// ---------- 4. reference-directed video: every rule refuses before fal ----------
const before = await balance()
const refuse = async (label: string, args: Record<string, unknown>, status: number, pattern: RegExp) => {
  const r = await run('generate_video', { projectId, prompt: 'x', ...args }, true)
  assert.equal(r.status, status, `${label}: expected ${status}, got ${r.status} ${r.body}`)
  assert.match(r.body, pattern, `${label}: the refusal should teach — ${r.body}`)
}
await refuse('references on a text model', { model: 'ltx-video', referenceVideos: [reel] }, 400, /seedance-2\.5-ref/)
await refuse('no durationSec on a per-second model', { model: 'seedance-2.5-ref', referenceVideos: [reel] }, 400, /durationSec/)
await refuse('a video reference as a URL', { model: 'seedance-2.5-ref', durationSec: 5, referenceVideos: ['https://example.com/a.mp4'] }, 400, /asset ids/)
await refuse('a reference naming nothing', { model: 'seedance-2.5-ref', durationSec: 5, referenceVideos: ['nope'] }, 404, /list_assets/)
await refuse('more videos than allowed', { model: 'seedance-2.5-ref', durationSec: 5, referenceVideos: Array(11).fill(reel) }, 400, /at most 10/)
if ((imp.data.durationSec ?? 0) * 3 > 30.2) {
  await refuse('too much reference video in total', { model: 'seedance-2.5-ref', durationSec: 5, referenceVideos: [reel, reel, reel] }, 400, /30\.2s/)
}
await refuse('resolution on a model without a choice', { model: 'ltx-video', resolution: '480p' }, 400, /no resolution choice/)
assert.equal(await balance(), before, 'refused generations must never cost credits')

await ok('delete_project', { projectId, confirm: true })
console.log(
  `social OK — imported ${imp.data.durationSec}s by @${imp.data.author} (${Math.round(imp.data.bytes / 1024)}KB, real MP4), ` +
    `shot detection found ${shots.segments.length} segment(s), and all reference-video refusals fired for free (${before} → ${before})`,
)
