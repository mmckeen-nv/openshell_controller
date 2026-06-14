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
assert.match(proxySource, /CONTROL_AUTH_COOKIE_NAME = 'openshell_control_session'/, 'HTTP proxy must know the controller auth cookie name')
assert.match(proxySource, /lowerKey === 'cookie' \? filterCookieHeader\(value\) : value/, 'HTTP proxy must strip controller auth cookies before forwarding to OpenClaw')
assert.match(proxySource, /OPENCLAW_DASHBOARD_TOKEN_COOKIE/, 'HTTP proxy must know the dashboard token bridge cookie name')
assert.match(proxySource, /headers\.set\('authorization', `Bearer \$\{dashboardToken\}`\)/, 'HTTP proxy must bridge the dashboard token cookie into upstream Authorization')
// The default fallback now derives the port from OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT
// (defaulting to 18789). Match across two lines while still asserting that the env-var
// override is honoured and the loopback host is preserved.
assert.match(
  serverSource,
  /controlUiOrigin: process\.env\.OPENCLAW_SANDBOX_CONTROL_UI_ORIGIN[\s\S]{0,200}?127\.0\.0\.1.*?(?:18789|OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT)/,
  'sandbox instances must preserve the gateway internal control UI origin (loopback 127.0.0.1 on the configured remote dashboard port, defaulting to 18789)',
)
assert.match(serverSource, /openClawDashboardTokenCookieName = 'openclaw_dashboard_token'/, 'WebSocket tunnel must know the dashboard token bridge cookie name')
assert.match(serverSource, /withDashboardTokenQuery\(upstreamWsUrl, dashboardToken\)/, 'WebSocket tunnel must add the dashboard token to the upstream websocket handshake URL')
assert.match(serverSource, /redactSensitiveUrl\(upstreamUrlWithToken\)/, 'WebSocket tunnel logs must redact tokenized upstream URLs')
assert.match(serverSource, /const upstreamUrl = withDashboardTokenQuery\(context\.upstreamWsUrl, dashboardToken\)/, 'WebSocket bridge must add the dashboard token to the upstream websocket URL')
assert.match(serverSource, /const redactedUpstreamUrl = redactSensitiveUrl\(upstreamUrl\)/, 'WebSocket bridge logs must redact tokenized upstream URLs')
assert.match(serverSource, /headers\.push\(`Host: \$\{upstreamWsUrl\.host\}`\)[\s\S]*headers\.push\(`Upgrade:/, 'WebSocket tunnel must normalize handshake headers with Host before upgrade fields for OpenClaw')
assert.match(serverSource, /headers\.push\(`Origin: \$\{controlUiOrigin\}`\)/, 'WebSocket tunnel must rewrite Origin to the gateway control UI origin')
assert.match(serverSource, /rawHeaders\.get\('cookie'\)[\s\S]*filterCookieHeader\(header\.value\)/, 'WebSocket tunnel must strip controller auth cookies before forwarding to OpenClaw')
assert.match(serverSource, /headers\.push\(`Authorization: Bearer \$\{dashboardToken\}`\)/, 'WebSocket tunnel must bridge the dashboard token cookie into upstream Authorization')
assert.match(serverSource, /function handleDashboardProxyUpgrade[\s\S]*dashboardWss\.handleUpgrade/, 'dashboard websocket upgrades must use the authenticated WebSocket bridge')

console.log('openclaw-dashboard-origin-rewrite-check: PASS dashboard proxy origin rewrite assertions')
