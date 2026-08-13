// Generates per-worker .dev.vars from the root .env (+ .env.local overrides),
// since wrangler only reads .dev.vars next to each wrangler.jsonc.
// Runs automatically via the root dev:api / dev:mcp scripts.
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

const env = { ...parse(join(root, '.env')), ...parse(join(root, '.env.local')) }

const targets = {
  'apps/api/.dev.vars': [
    'BETTER_AUTH_SECRET',
    'BETTER_AUTH_API_KEY',
    'TUNNEL_ORIGIN',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'INTERNAL_API_KEY',
    'DEV_ALLOW_ANON',
  ],
  'apps/mcp/.dev.vars': ['INTERNAL_API_KEY'],
}

for (const [file, keys] of Object.entries(targets)) {
  const body = keys
    .filter((k) => env[k] !== undefined)
    .map((k) => `${k}=${env[k]}`)
    .join('\n')
  writeFileSync(join(root, file), `# generated from .env/.env.local — edit those, not this\n${body}\n`)
  console.log(`wrote ${file}`)
}
