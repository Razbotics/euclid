/**
 * Every fal roster model, end to end through our own stack (plans/009).
 * Run: pnpm --filter @euclid/renderer exec tsx src/check-fal-roster.ts [model...]
 *
 * **SPENDS REAL MONEY — roughly $0.50 for the full roster**, most of it
 * `kling-video`. `check-fal.ts` is the cheap everyday check; this one exists to
 * close a specific gap: a roster entry's `output()` reader is the one part that
 * cannot be verified by submitting, because it only runs on a *successful*
 * result. Run it when the roster changes, not on every commit.
 *
 * Named models only run those; no arguments runs all of them.
 *
 * Note what a reader failure costs: fal has already charged us for the
 * inference, and we refund the user's credits, so a wrong reader is the one
 * bug here that loses money quietly. Hence this script.
 *
 * Needs `dev:api` with FAL_KEY. No renderer needed: this checks that each
 * model produces a correct *file*; check-glb.ts covers drawing one.
 */
import './load-env'
import { writeFileSync } from 'node:fs'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.INTERNAL_API_KEY ?? 'dev-internal-key'
const FAL_KEY = process.env.FAL_KEY ?? ''
const H = { 'content-type': 'application/json', 'x-internal-key': KEY, 'x-user-id': 'dev-user' }
const OUT = process.env.OUT_DIR ?? '/tmp'

if (!FAL_KEY) {
  console.error('FAL_KEY missing — this script talks to fal directly to mint a seed image')
  process.exit(1)
}

const run = async (n: string, a: Record<string, unknown>, paid = false) => {
  const r = await fetch(`${API}/api/agent/tools/${n}/execute?format=json${paid ? '&paid=1' : ''}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(a),
  })
  const b = await r.text()
  if (r.status !== 200) throw new Error(`${n} ${r.status}: ${b.slice(0, 300)}`)
  return JSON.parse(b) as { text: string; data: any }
}
const balance = async (): Promise<number> =>
  ((await (await fetch(`${API}/api/billing/balance`, { headers: H })).json()) as any).balance

/** What the bytes actually are, independent of the mime anyone claimed. */
function sniff(b: Buffer): string {
  const ascii = (o: number, n: number) => b.subarray(o, o + n).toString('ascii')
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav'
  if (ascii(0, 4) === 'glTF') return 'glb'
  if (ascii(4, 4) === 'ftyp') return 'mp4'
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm'
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'mp3'
  if (ascii(0, 4) === 'fLaC') return 'flac'
  if (ascii(0, 1) === '{' || ascii(0, 1) === '<') return `TEXT/ERROR: ${ascii(0, 80)}`
  return `unknown (${[...b.subarray(0, 4)].map((x) => x.toString(16)).join(' ')})`
}

const EXPECTED: Record<string, string[]> = {
  image: ['jpeg', 'png', 'webp'],
  video: ['mp4', 'webm'],
  audio: ['mp3', 'wav', 'flac'],
  model: ['glb'],
}

/**
 * A public image for the image-to-3D models. Minted straight from fal rather
 * than from a project asset, because project assets are not publicly readable
 * and fal has to fetch this itself. It is a fixture, not the thing under test.
 */
async function seedImageUrl(): Promise<string> {
  const auth = { Authorization: `Key ${FAL_KEY}`, 'content-type': 'application/json' }
  const sub = await fetch('https://queue.fal.run/fal-ai/flux/schnell', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      prompt: 'a single smooth ceramic owl figurine, centred, plain white background, studio light',
      image_size: 'square_hd',
      num_images: 1,
    }),
  })
  const { status_url, response_url } = (await sub.json()) as any
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const st = (await (await fetch(status_url, { headers: auth })).json()) as any
    if (st.status === 'COMPLETED') break
    if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') {
      throw new Error(`seed image failed: ${JSON.stringify(st).slice(0, 200)}`)
    }
  }
  const body = (await (await fetch(response_url, { headers: auth })).json()) as any
  const url = body?.images?.[0]?.url
  if (!url) throw new Error(`seed image produced no url: ${JSON.stringify(body).slice(0, 200)}`)
  return url
}

// ---------- which models ----------

const catalog = (await (await fetch(`${API}/api/agent/tools?format=json`, { headers: H })).json()) as any
void catalog // the roster lives in the worker; names below mirror fal.ts

const ALL: { name: string; kind: string }[] = [
  { name: 'flux-schnell', kind: 'image' },
  { name: 'flux-dev', kind: 'image' },
  { name: 'flux-pro', kind: 'image' },
  { name: 'ltx-video', kind: 'video' },
  { name: 'kling-video', kind: 'video' },
  { name: 'flux-i2i', kind: 'image' },
  { name: 'ltx-video-i2v', kind: 'video' },
  { name: 'kling-video-i2v', kind: 'video' },
  { name: 'stable-audio', kind: 'audio' },
  { name: 'trellis', kind: 'model' },
  { name: 'hunyuan3d', kind: 'model' },
]
const wanted = process.argv.slice(2)
const targets = wanted.length ? ALL.filter((m) => wanted.includes(m.name)) : ALL
if (targets.length === 0) {
  console.error(`no such model. Known: ${ALL.map((m) => m.name).join(', ')}`)
  process.exit(1)
}

/** The image-conditioned entries, which need something to be conditioned on. */
const grounded = (name: string) => name.endsWith('-i2i') || name.endsWith('-i2v')

const needsSeed = targets.some((m) => m.kind === 'model')
const seed = needsSeed ? await seedImageUrl() : ''
if (needsSeed) console.log(`seed image for image-to-3D: ${seed.slice(0, 80)}…\n`)

const projectId = (await run('create_project', { name: 'Fal Roster Check' })).data.id
// Review mode is on by default (plans/010), and it gates every paid generation
// behind an approved plan. This script is testing the provider, not the review
// lifecycle — check-review.ts owns that — so it opts out explicitly.
await run('set_review_mode', { projectId, enabled: false })
/**
 * What the grounded models are grounded ON: a still generated into this very
 * project, referenced by **asset id**.
 *
 * Deliberately not a public URL like the 3D seed above. An asset id is the case
 * the recipe actually needs (docs/recipes.md — the reference is nearly always a
 * frame this system just made), and it is the harder one: the bytes are private,
 * so they have to be read out of R2 and inlined as a data URL before fal ever
 * sees them. Passing a URL here would leave that path untested.
 */
let groundAsset = ''
if (targets.some((m) => grounded(m.name))) {
  const seedGen = await run(
    'generate_image',
    {
      projectId,
      model: 'flux-schnell',
      prompt: 'a red ceramic teapot on a pale grey table, plain background, soft studio light',
      path: '/images/ground.jpg',
    },
    true,
  )
  groundAsset = seedGen.data.assetId
  if (!groundAsset) throw new Error(`grounding seed did not finish: ${seedGen.text}`)
  console.log(`grounding reference (project asset): ${groundAsset}\n`)
}

const rows: string[] = []
let failures = 0

for (const m of targets) {
  const before = await balance()
  const started = Date.now()
  let line = `${m.name.padEnd(14)} ${m.kind.padEnd(6)}`
  try {
    const args: Record<string, unknown> =
      grounded(m.name)
        ? {
            projectId,
            model: m.name,
            imageUrl: groundAsset,
            prompt:
              m.kind === 'image'
                ? 'the same teapot, but glazed deep blue'
                : 'the camera pushes slowly towards the teapot',
            ...(m.name === 'flux-i2i' ? { strength: 0.6 } : {}),
          }
        : m.kind === 'model'
        ? { projectId, model: m.name, imageUrl: seed }
        : m.kind === 'audio'
          ? { projectId, model: m.name, prompt: 'a warm ambient synth pad, slow swell', durationSec: 10 }
          : m.kind === 'video'
            ? { projectId, model: m.name, prompt: 'a slow push in on a glowing glass sphere on black' }
            : { projectId, model: m.name, prompt: 'a single matte ceramic sphere, plain background' }
    const tool =
      m.kind === 'model'
        ? 'generate_3d'
        : m.kind === 'audio'
          ? 'generate_audio'
          : m.kind === 'video'
            ? 'generate_video'
            : 'generate_image'

    const sub = await run(tool, args, true)
    let job = sub.data
    // Up to ~10 minutes; kling is the slow one.
    for (let i = 0; i < 120 && job.status === 'pending'; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      const s = await run('get_generation_status', { projectId })
      job = (s.data.jobs as any[]).find((j) => j.id === job.jobId) ?? job
      job = { ...job, jobId: job.id ?? job.jobId, assetId: job.asset_id ?? job.assetId }
    }
    const took = Math.round((Date.now() - started) / 1000)

    if (job.status !== 'done') {
      failures++
      line += `FAILED after ${took}s — ${String(job.error ?? 'still pending').slice(0, 150)}`
      // The reader is the usual suspect, and the raw body is still fetchable.
      line += `\n${' '.repeat(21)}(job ${String(job.jobId ?? job.id).slice(0, 8)} — inspect its response_url to fix output())`
    } else {
      const res = await fetch(`${API}/api/assets/${job.assetId}`, { headers: H })
      const bytes = Buffer.from(await res.arrayBuffer())
      const kind = sniff(bytes)
      const good = EXPECTED[m.kind]!.includes(kind)
      if (!good) failures++
      const ext = kind === 'TEXT/ERROR' ? 'txt' : kind
      writeFileSync(`${OUT}/roster-${m.name}.${ext}`, bytes)
      const spent = before - (await balance())
      line +=
        `${good ? 'OK  ' : 'BAD '} ${took}s  ${String(Math.round(bytes.length / 1024)).padStart(5)}KB  ` +
        `sniffed=${kind}  claimed=${res.headers.get('content-type')}  ${spent} credits`
    }
  } catch (e) {
    failures++
    line += `ERROR ${(e as Error).message.slice(0, 200)}`
  }
  console.log(line)
  rows.push(line)
}

console.log(`\nfiles in ${OUT}/roster-*`)
console.log(
  failures === 0
    ? `roster OK — ${targets.length}/${targets.length} models produced a file of the right type`
    : `roster: ${targets.length - failures}/${targets.length} passed, ${failures} need attention`,
)
if (failures > 0) process.exitCode = 1
