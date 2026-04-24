import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const proxyPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const serverPath = path.join(root, 'server.mjs')

const proxySource = await readFile(proxyPath, 'utf8')
const serverSource = await readFile(serverPath, 'utf8')

assert.match(proxySource, /const targetOrigin = target\.origin/, 'HTTP proxy must derive an upstream-safe target origin')
assert.match(proxySource, /lowerKey !== 'origin'/, 'HTTP proxy must not forward browser Origin to OpenClaw')
assert.match(proxySource, /headers\.set\('origin', targetOrigin\)/, 'HTTP proxy must rewrite Origin to the loopback/tunnel upstream origin')
assert.match(proxySource, /headers\.set\('referer', `\$\{targetOrigin\}\/`\)/, 'HTTP proxy must rewrite Referer to the upstream origin')
assert.match(serverSource, /headers\.push\(`Origin: \$\{upstreamOrigin\.origin\}`\)/, 'WebSocket tunnel must continue rewriting Origin for gateway upgrades')

console.log('openclaw-dashboard-origin-rewrite-check: PASS dashboard proxy origin rewrite assertions')
