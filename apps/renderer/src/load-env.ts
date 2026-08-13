/** Loads root .env (+ .env.local overrides) into process.env. Real env vars win. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..', '..', '..')
const merged: Record<string, string> = {}
for (const name of ['.env', '.env.local']) {
  const file = join(root, name)
  if (!existsSync(file)) continue
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m) merged[m[1]!] = m[2]!
  }
}
for (const [k, v] of Object.entries(merged)) {
  if (process.env[k] === undefined) process.env[k] = v
}
