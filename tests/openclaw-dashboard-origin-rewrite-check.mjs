import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const proxyPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const serverPath = path.join(root, 'server.mjs')

const proxySource = await readFile(proxyPath, 'utf8')
const serverSource = await readFile(serverPath, 'utf8')

assert.match(proxySource, /controlUiOrigin: authority\.openclaw\.controlUiOrigin/, 'HTTP proxy must resolve the OpenClaw control UI origin separately from the transport URL')
assert.match(proxySource, /lowerKey !== 'origin'/, 'HTTP proxy must not forward browser Origin to OpenClaw')
assert.match(proxySource, /headers\.set\('origin', controlUiOrigin\)/, 'HTTP proxy must rewrite Origin to the gateway control UI origin')
assert.match(proxySource, /headers\.set\('referer', `\$\{controlUiOrigin\}\/`\)/, 'HTTP proxy must rewrite Referer to the gateway control UI origin')
assert.match(serverSource, /controlUiOrigin: process\.env\.OPENCLAW_SANDBOX_CONTROL_UI_ORIGIN \|\| 'http:\/\/127\.0\.0\.1:18789'/, 'sandbox instances must preserve the gateway internal control UI origin')
assert.match(serverSource, /headers\.push\(`Origin: \$\{controlUiOrigin\}`\)/, 'WebSocket tunnel must rewrite Origin to the gateway control UI origin')

console.log('openclaw-dashboard-origin-rewrite-check: PASS dashboard proxy origin rewrite assertions')
