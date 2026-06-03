import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

const runtimeAuthorityPath = path.join(root, 'app/lib/runtimeAuthority.ts')
const dashboardOpenPath = path.join(root, 'app/api/openshell/dashboard/open/route.ts')
const dashboardProxySharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const terminalLivePath = path.join(root, 'app/api/openshell/terminal/live/route.ts')
const terminalReadinessPath = path.join(root, 'app/api/openshell/terminal/readiness/route.ts')
const telemetryPath = path.join(root, 'app/api/telemetry/real/route.ts')
const openshellHostPath = path.join(root, 'app/lib/openshellHost.ts')
const sandboxHealthPath = path.join(root, 'app/api/sandbox/[sandboxId]/health/route.ts')
const packageJsonPath = path.join(root, 'package.json')
const serverPath = path.join(root, 'server.mjs')

const [runtimeAuthoritySource, dashboardOpenSource, dashboardProxySource, terminalLiveSource, terminalReadinessSource, telemetrySource, openshellHostSource, sandboxHealthSource, packageJsonSource, serverSource] = await Promise.all([
  readFile(runtimeAuthorityPath, 'utf8'),
  readFile(dashboardOpenPath, 'utf8'),
  readFile(dashboardProxySharedPath, 'utf8'),
  readFile(terminalLivePath, 'utf8'),
  readFile(terminalReadinessPath, 'utf8'),
  readFile(telemetryPath, 'utf8'),
  readFile(openshellHostPath, 'utf8'),
  readFile(sandboxHealthPath, 'utf8'),
  readFile(packageJsonPath, 'utf8'),
  readFile(serverPath, 'utf8'),
])

assert.match(runtimeAuthoritySource, /export function resolveRuntimeAuthority\(/, 'runtime authority resolver must exist')
assert.match(runtimeAuthoritySource, /mappedSandboxInstanceId = getOpenClawInstanceIdForSandbox\(resolvedSandboxId\)/, 'runtime authority must derive sandbox instance mapping from resolved sandbox id')
assert.match(runtimeAuthoritySource, /requestedInstanceId\s*\?\s*resolveOpenClawInstance\(requestedInstanceId\)/, 'runtime authority must allow explicit instance override')

assert.match(dashboardOpenSource, /const sandboxId = requestUrl\.searchParams\.get\('sandboxId'\)/, 'dashboard open route must still read sandboxId explicitly')
assert.match(dashboardOpenSource, /const authority = resolveRuntimeAuthority\(/, 'dashboard open route must use shared runtime authority resolution')
assert.match(dashboardOpenSource, /authority:\s*\{[\s\S]*sandboxAuthority:/, 'dashboard open route must expose authority provenance')
assert.match(dashboardOpenSource, /bootstrapUrl: probe\.bootstrapUrl/, 'dashboard open route must surface the resolved bootstrap URL explicitly')
assert.match(dashboardOpenSource, /bootstrapAuthority: probe\.bootstrapAuthority/, 'dashboard open route must surface tokenized bootstrap authority explicitly')
assert.match(dashboardOpenSource, /probe\.bootstrapAuthority === 'tokenized-cli'/, 'dashboard open route truth must prefer tokenized bootstrap evidence over raw loopback fetch alone')
assert.match(dashboardOpenSource, /process\.env\.OPENCLAW_DASHBOARD_BASE_WS_URL\?\.trim\(\) \|\| process\.env\.BASE_WS_URL\?\.trim\(\) \|\| null/, 'dashboard open route must allow a fully qualified browser websocket base URL')
assert.match(dashboardOpenSource, /const wsProxyPort = process\.env\.OPENCLAW_DASHBOARD_WS_PROXY_PORT\?\.trim\(\) \|\| ''/, 'dashboard open route must not hardcode the dedicated websocket sidecar port')

assert.match(dashboardProxySource, /resolveRuntimeAuthority\(\{[\s\S]*sandboxId: requestUrl\.searchParams\.get\('sandboxId'\)/, 'dashboard proxy must resolve target from shared authority source')
assert.match(dashboardProxySource, /x-openclaw-dashboard-bootstrap-contract/, 'dashboard proxy must mark the tokenized bootstrap bridge contract in response headers')
assert.match(dashboardProxySource, /copyRequestHeaders/, 'dashboard proxy should forward browser request headers upstream')
assert.match(dashboardProxySource, /upstreamInit\.duplex = 'half'/, 'dashboard proxy should forward non-GET request bodies upstream')

assert.match(terminalLiveSource, /const authority = resolveRuntimeAuthority\(/, 'terminal live route must use shared runtime authority resolution')
assert.match(terminalLiveSource, /authority:\s*\{[\s\S]*usedMappedSandboxInstance:/, 'terminal live route must expose authority provenance')

assert.match(terminalReadinessSource, /terminalFallback: true/, 'terminal readiness must explicitly represent terminal fallback state')
assert.match(terminalReadinessSource, /const authority = resolveRuntimeAuthority\(/, 'terminal readiness must use shared runtime authority resolution')

assert.match(telemetrySource, /authoritySource: "runtimeAuthority"/, 'inventory route must declare shared authority source')
assert.match(telemetrySource, /authorities: authorities\.map\(/, 'inventory route must expose per-sandbox authority metadata')
assert.match(openshellHostSource, /const OPENSHELL_GATEWAY = process\.env\.OPENSHELL_GATEWAY\?\.trim\(\) \|\| undefined/, 'OpenShell host commands must not force the legacy openshell gateway when NemoClaw has selected the nemoclaw gateway')
assert.match(sandboxHealthSource, /stripAnsi/, 'sandbox health must strip OpenShell ANSI styling before parsing fields such as Phase')
assert.match(openshellHostSource, /const canMintBootstrapFromCli = instance\.id === defaultInstance\.id/, 'bootstrap minting should only use CLI for the default OpenClaw instance')
assert.match(openshellHostSource, /readSandboxOpenClawDashboardToken/, 'sandbox dashboard bootstrap must fall back to the sandbox OpenClaw token when CLI output is bare')
assert.match(openshellHostSource, /openclaw dashboard', 15000\)\.catch/, 'sandbox dashboard bootstrap should let OpenClaw initialize before reading the fallback token')
assert.match(openshellHostSource, /withDashboardToken\(tokenizedBootstrapUrl, token\)/, 'sandbox dashboard bootstrap should synthesize a tokenized launch URL from the fallback token')
assert.match(packageJsonSource, /"dev": "NODE_ENV=development node server\.mjs"/, 'development script must run through the custom server so websocket proxy bridges are active')
assert.match(packageJsonSource, /"start": "NODE_ENV=production node server\.mjs"/, 'production start must run the custom server without Next dev-mode heap growth')
assert.match(serverSource, /const dashboardWsProxyPort = parseOptionalPort\(process\.env\.OPENCLAW_DASHBOARD_WS_PROXY_PORT/, 'custom server must make the dedicated dashboard websocket sidecar opt-in')
assert.match(serverSource, /const dashboardWsProxyServer = dashboardWsProxyPort\s*\?\s*http\.createServer/, 'custom server must only provision the sidecar when explicitly configured')
assert.match(serverSource, /dashboard-sidecar-listening/, 'custom server must still expose the optional dashboard websocket sidecar listener')
assert.match(serverSource, /dashboard-upgrade-accepted/, 'custom server must accept dashboard websocket upgrades through the proxy path')

console.log('runtime-authority-resolution-check: PASS shared authority resolution assertions')
