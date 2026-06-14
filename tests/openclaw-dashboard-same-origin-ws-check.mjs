import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const openRoutePath = path.join(root, 'app/api/openshell/dashboard/open/route.ts')
const sharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')

const openRouteSource = await readFile(openRoutePath, 'utf8')
const sharedSource = await readFile(sharedPath, 'utf8')

// The env var must default to '' (same-origin) when unset; the previous regression
// hardcoded :3001 which broke any deployment that didn't set the proxy port.
// `?? ''` and `|| ''` are functionally identical for trimmed-string fallback, so
// accept either — the load-bearing assertion is the doesNotMatch on '3001'.
assert.match(
  openRouteSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\)\s*(?:\?\?|\|\|)\s*''/,
  'dashboard open route: unset OPENCLAW_DASHBOARD_WS_PROXY_PORT must default to same-origin (empty), not hardcoded :3001'
)
assert.doesNotMatch(
  openRouteSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT[^\n]*'3001'/,
  'dashboard open route: must not fall back to :3001 when env var is unset'
)

assert.match(
  sharedSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\)\s*(?:\?\?|\|\|)\s*''/,
  'dashboard bootstrap: unset OPENCLAW_DASHBOARD_WS_PROXY_PORT must default to same-origin (empty), not hardcoded :3001'
)
assert.doesNotMatch(
  sharedSource,
  /OPENCLAW_DASHBOARD_WS_PROXY_PORT[^\n]*'3001'/,
  'dashboard bootstrap: must not fall back to :3001 when env var is unset'
)

// Same-origin invariant: the sidecar/port gateway URL is built only when
// wsProxyPort is set; otherwise the SPA falls back to pageGatewayUrl which
// uses window.location.host. This is the regression guard against hardcoded
// :3001 / mismatched-port deployments.
assert.match(
  sharedSource,
  /portGatewayUrl = wsProxyPort \? protocol \+ '\/\/' \+ window\.location\.hostname \+ ':' \+ wsProxyPort \+ proxyPrefix : ''/,
  'dashboard bootstrap: portGatewayUrl must only fill when wsProxyPort is set; same-origin path is the empty-string fallback',
)
assert.match(
  sharedSource,
  /pageGatewayUrl = protocol \+ '\/\/' \+ window\.location\.host \+ proxyPrefix/,
  'dashboard bootstrap: pageGatewayUrl must use window.location.host (the same-origin fallback)',
)
assert.match(
  sharedSource,
  /defaultGatewayUrl = configuredGatewayUrl \|\| portGatewayUrl \|\| pageGatewayUrl/,
  'dashboard bootstrap: defaultGatewayUrl precedence must be configured > sidecar port > same-origin page host',
)

// The gatewayUrl hash param takes precedence over the computed default.
assert.match(
  sharedSource,
  /const gatewayUrl = normalizeGatewayUrl\(hashParams\.get\('gatewayUrl'\)\) \|\| defaultGatewayUrl/,
  'dashboard bootstrap: explicit gatewayUrl from launch hash must override the computed defaultGatewayUrl',
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
