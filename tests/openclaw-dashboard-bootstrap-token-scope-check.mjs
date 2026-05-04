import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const proxyPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const proxySource = await readFile(proxyPath, 'utf8')

assert.match(
  proxySource,
  /const pageGatewayUrl = protocol \+ '\/\/' \+ window\.location\.host \+ proxyPrefix/,
  'dashboard bootstrap should know the same-origin websocket gateway scope'
)
assert.match(
  proxySource,
  /const sidecarGatewayUrl = protocol \+ '\/\/' \+ sidecarHost \+ proxyPrefix/,
  'dashboard bootstrap should know the dedicated websocket sidecar gateway scope'
)
assert.match(
  proxySource,
  /const gatewayUrl = \(hashParams\.get\('gatewayUrl'\) \|\| ''\)\.trim\(\) \|\| sidecarGatewayUrl/,
  'dashboard bootstrap should honor the tokenized launch gateway URL'
)
assert.match(
  proxySource,
  /const settingsPrefix = 'openclaw\.control\.settings\.v1:';/,
  'dashboard bootstrap should write OpenClaw scoped settings'
)
assert.match(
  proxySource,
  /const gatewayScopes = uniqueScopes\(\[gatewayUrl, sidecarGatewayUrl, pageGatewayUrl\]\)/,
  'dashboard bootstrap should seed token scopes for launch, sidecar, and page gateways'
)
assert.match(
  proxySource,
  /for \(const key of settingsKeys\) window\.localStorage\.setItem\(key, serializedSettings\)/,
  'dashboard bootstrap should write settings to all gateway-scoped keys'
)
assert.match(
  proxySource,
  /for \(const scope of gatewayScopes\) window\.sessionStorage\.setItem\(tokenPrefix \+ scope, token\)/,
  'dashboard bootstrap should write the OpenClaw token to every gateway scope'
)
assert.doesNotMatch(
  proxySource,
  /const tokenScope = gatewayUrl/,
  'dashboard bootstrap must not restrict the token to only one gateway scope'
)

console.log('openclaw-dashboard-bootstrap-token-scope-check: PASS dashboard bootstrap token scope assertions')
