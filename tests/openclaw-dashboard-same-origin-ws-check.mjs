import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const openRoutePath = path.join(root, 'app/api/openshell/dashboard/open/route.ts')
const sharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')

const openRouteSource = await readFile(openRoutePath, 'utf8')
const sharedSource = await readFile(sharedPath, 'utf8')

// The env var must use ?? '' not || '3001' so that an unset env var defaults to same-origin (empty port)
assert.match(
  openRouteSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\) \?\? ''/,
  'dashboard open route: unset OPENCLAW_DASHBOARD_WS_PROXY_PORT must default to same-origin (empty), not hardcoded :3001'
)
assert.doesNotMatch(
  openRouteSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\) \|\| '3001'/,
  'dashboard open route: must not fall back to :3001 when env var is unset'
)

assert.match(
  sharedSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\) \?\? ''/,
  'dashboard bootstrap: unset OPENCLAW_DASHBOARD_WS_PROXY_PORT must default to same-origin (empty), not hardcoded :3001'
)
assert.doesNotMatch(
  sharedSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\) \|\| '3001'/,
  'dashboard bootstrap: must not fall back to :3001 when env var is unset'
)

// When wsProxyPort is empty the gateway host must use window.location.host (includes port if non-standard)
assert.match(
  sharedSource,
  /const sidecarHost = wsProxyPort \? window\.location\.hostname \+ ':' \+ wsProxyPort : window\.location\.host/,
  'dashboard bootstrap: empty wsProxyPort must use window.location.host for same-origin websocket'
)

// The gatewayUrl hash param takes precedence over the sidecar default
assert.match(
  sharedSource,
  /const gatewayUrl = \(hashParams\.get\('gatewayUrl'\) \|\| ''\)\.trim\(\) \|\| sidecarGatewayUrl/,
  'dashboard bootstrap: explicit gatewayUrl from launch hash must override computed sidecar gateway'
)

// Server-side: when wsProxyPort is empty the gateway host falls through to host (forwarded or direct)
assert.match(
  openRouteSource,
  /const gatewayHost = wsProxyPort\s*\n\s*\? new URL\(`\$\{requestUrl\.protocol\}\/\/\$\{host\}`\)\.hostname \+ `:\$\{wsProxyPort\}`\s*\n\s*: host/,
  'dashboard open route: empty wsProxyPort must use the full host (respects x-forwarded-host) for same-origin websocket'
)

// Token must be embedded directly in gatewayUrl stored to localStorage
assert.match(
  sharedSource,
  /const effectiveGatewayUrl = token/,
  'dashboard bootstrap: token must be embedded in gatewayUrl via effectiveGatewayUrl'
)
assert.match(
  sharedSource,
  /settings\.gatewayUrl = effectiveGatewayUrl/,
  'dashboard bootstrap: settings.gatewayUrl must use effectiveGatewayUrl (with embedded token)'
)
assert.doesNotMatch(
  sharedSource,
  /settings\.gatewayUrl = gatewayUrl(?!.*effectiveGatewayUrl)/s,
  'dashboard bootstrap: must not store bare gatewayUrl without token embedding'
)

console.log('openclaw-dashboard-same-origin-ws-check: PASS same-origin WebSocket default assertions')
