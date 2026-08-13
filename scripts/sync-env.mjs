// Generates per-worker .dev.vars from the root .env (+ .env.local overrides),
// since wrangler only reads .dev.vars next to each wrangler.jsonc.
// Runs automatically via the root dev:api / dev:mcp scripts.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function parse(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// .env holds production values; .env.local overrides per machine and wins.
const env = { ...parse(join(root, '.env')), ...parse(join(root, '.env.local')) }
if (!existsSync(join(root, '.env'))) {
  console.error('missing .env — copy .env.example and fill it in')
  process.exit(1)
}

const targets = {
  'apps/api/.dev.vars': [
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_API_KEY',
    'TUNNEL_ORIGIN',
    'PUBLIC_API_ORIGIN',
    'ELEVENLABS_API_KEY',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'INTERNAL_API_KEY',
    'DEV_ALLOW_ANON',
  ],
  'apps/mcp/.dev.vars': ['INTERNAL_API_KEY'],
}

let changed = false
for (const [file, keys] of Object.entries(targets)) {
  const path = join(root, file)
  const body = keys
    .filter((k) => env[k] !== undefined)
    .map((k) => `${k}=${env[k]}`)
    .join('\n')
  const next = `# generated from .env/.env.local — edit those, not this\n${body}\n`
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (prev !== next) changed = true
  writeFileSync(path, next)
  console.log(`wrote ${file}`)
}

// wrangler does not reliably hot-reload .dev.vars — a stale worker silently
// keeps serving old secrets, which looks like a broken integration.
if (changed) {
  let running = false
  try {
    execSync('pgrep -f "wrangler dev" > /dev/null 2>&1')
    running = true
  } catch {
    running = false
  }
  if (running) {
    console.log('\n⚠  Values changed while a worker is running.')
    console.log('   Restart it or the old values stay live: pkill -f "wrangler dev" && pnpm dev:api\n')
  }
}
