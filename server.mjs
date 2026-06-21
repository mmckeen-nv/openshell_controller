import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import next from 'next'
import { WebSocketServer, WebSocket } from 'ws'
import {
  verifyOperatorSession as authVerifyOperatorSession,
  verifyOAuthJWT as authVerifyOAuthJWT,
  parseSandboxAccessCSV,
  isEmailAuthorizedForSandbox,
  emailFromOAuthPayload,
  extractSandboxIdFromUrl,
  parseCookieHeader,
  OAUTH_COOKIE_NAME,
  LEGACY_OAUTH_COOKIE_NAME,
} from './app/lib/auth/node.mjs'

function loadLocalEnvFile(pathname) {
  if (!existsSync(pathname)) return
  const lines = readFileSync(pathname, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!match || process.env[match[1]]) continue
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
}

loadLocalEnvFile('.env.local')

function parseOptionalPort(value, name) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535`)
  }
  return parsed
}

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || process.env.NEXT_PUBLIC_DASHBOARD_PORT || 3000)
const dashboardWsProxyPort = parseOptionalPort(process.env.OPENCLAW_DASHBOARD_WS_PROXY_PORT, 'OPENCLAW_DASHBOARD_WS_PROXY_PORT')
const terminalServerUrl = new URL(process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011')
const terminalWsProtocol = terminalServerUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const terminalProxyPath = '/api/openshell/terminal/live/ws'
const legacyDashboardProxyPrefix = '/api/openshell/dashboard/proxy'
const instancesProxyPrefix = '/api/openshell/instances/'
const dashboardProxySuffix = '/dashboard/proxy'
const defaultDashboardUrl = process.env.OPENCLAW_DASHBOARD_URL || 'http://127.0.0.1:18789/'
const defaultInstanceId = 'default'
const sandboxDashboardPortBase = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_PORT_BASE || '19000', 10)
const sandboxDashboardPortRange = 2000
const authCookieName = 'openshell_control_session'
const openClawDashboardTokenCookieName = 'openclaw_dashboard_token'

function now() {
  return new Date().toISOString()
}

function logBridge(event, fields = {}) {
  const payload = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ')
  console.log(`[terminal-bridge] ts=${now()} event=${event}${payload ? ` ${payload}` : ''}`)
}

const managedChildren = new Set()
let managedChildShutdownHandlersInstalled = false

function stopManagedChildren() {
  for (const child of managedChildren) {
    if (!child.killed) child.kill('SIGTERM')
  }
}

function installManagedChildShutdownHandlers() {
  if (managedChildShutdownHandlersInstalled) return
  managedChildShutdownHandlersInstalled = true
  process.once('exit', stopManagedChildren)
  process.once('SIGINT', () => {
    stopManagedChildren()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    stopManagedChildren()
    process.exit(143)
  })
}

function registerManagedChild(child) {
  managedChildren.add(child)
  installManagedChildShutdownHandlers()
  child.once('exit', () => {
    managedChildren.delete(child)
  })
}

// File-backed sandbox-access store. We re-implement the read path in JS here
// because server.mjs runs outside the Next.js bundler and cannot import the
// TypeScript helper directly. The format must stay in sync with
// app/lib/auth/sandboxAccessStore.ts.
function readSandboxAccessFromFile() {
  const file = (process.env.SANDBOX_ACCESS_FILE && process.env.SANDBOX_ACCESS_FILE.trim())
    || `${process.cwd()}/data/sandbox-access.json`
  try {
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const map = new Map()
    for (const entry of entries) {
      const sandboxName = typeof entry?.sandboxName === 'string' ? entry.sandboxName.trim() : ''
      const email = typeof entry?.email === 'string' ? entry.email.trim().toLowerCase() : ''
      if (!sandboxName || !email) continue
      if (!map.has(sandboxName)) map.set(sandboxName, new Set())
      map.get(sandboxName).add(email)
    }
    return map
  } catch {
    return null
  }
}

function isAuthDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.OPENSHELL_CONTROL_AUTH_DISABLED || '')
}

function getAuthSecret() {
  return process.env.OPENSHELL_CONTROL_AUTH_SECRET || process.env.OPENSHELL_CONTROL_PASSWORD || ''
}

function filterCookieHeader(value) {
  return String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${authCookieName}=`) && !part.startsWith(`${openClawDashboardTokenCookieName}=`))
    .join('; ')
}

function readCookieValue(value, name) {
  const cookies = parseCookieHeader(value)
  return cookies[name] || null
}

function isAuthenticatedUpgrade(req) {
  if (isAuthDisabled()) return true
  if (!process.env.OPENSHELL_CONTROL_PASSWORD) return false
  const value = readCookieValue(req.headers.cookie, authCookieName)
  return Boolean(authVerifyOperatorSession(value, getAuthSecret()))
}

function rejectUnauthorizedUpgrade(req, socket, path) {
  logBridge('upgrade-auth-rejected', {
    path,
    remoteAddress: req.socket.remoteAddress || 'unknown',
  })
  socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}

function getOAuthJWTSecret() {
  // Match the priority order used by the Edge adapter in
  // app/lib/auth/context.ts so the two sides cannot disagree about which
  // secret is active.
  return (
    process.env.OAUTH_JWT_SECRET
    || process.env.MCPAUTH_JWT_SECRET
    || process.env.CF_AUTH_JWT_SECRET
    || ''
  )
}

function verifyOAuthSessionJWT(token) {
  return authVerifyOAuthJWT(token, getOAuthJWTSecret())
}

function getSandboxAccessMapForServer() {
  const fromFile = readSandboxAccessFromFile()
  if (fromFile && fromFile.size > 0) return fromFile
  return parseSandboxAccessCSV(process.env.SANDBOX_ACCESS_USERS || '')
}

function getSandboxIdFromUpgradeUrl(url) {
  try {
    const parsed = new URL(url || '/', `http://localhost:${port}`)
    return extractSandboxIdFromUrl(parsed.pathname, parsed.searchParams)
  } catch {
    return null
  }
}

function isOAuthSandboxUpgradeAuthorized(req) {
  // Prefer the new cookie name, fall back to the legacy CF_Authorization
  // alias for sessions issued by an older controller version.
  const oauthToken =
    readCookieValue(req.headers.cookie, OAUTH_COOKIE_NAME)
    || readCookieValue(req.headers.cookie, LEGACY_OAUTH_COOKIE_NAME)
  const payload = verifyOAuthSessionJWT(oauthToken)
  if (!payload) return false
  const email = emailFromOAuthPayload(payload)
  if (!email) return false
  const sandboxId = getSandboxIdFromUpgradeUrl(req.url)
  if (!sandboxId) return false
  const map = getSandboxAccessMapForServer()
  const authorized = isEmailAuthorizedForSandbox(map, email, sandboxId)
  if (authorized) {
    logBridge('ws-upgrade-oauth-authorized', {
      path: req.url || '/',
      sandboxId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
  }
  return authorized
}

function buildTerminalUpstreamUrl(req) {
  const incoming = new URL(req.url || '/', `http://${req.headers.host || `${hostname}:${port}`}`)
  const upstream = new URL('/ws', `${terminalWsProtocol}//${terminalServerUrl.host}`)
  incoming.searchParams.forEach((value, key) => upstream.searchParams.append(key, value))
  return upstream
}

function copyHeaders(req) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'undefined') continue
    const lowerKey = key.toLowerCase()
    if (
      ['connection', 'host', 'upgrade', 'x-forwarded-user'].includes(lowerKey) ||
      lowerKey.startsWith('sec-websocket-')
    ) {
      // x-forwarded-user is set only by trusted middleware; never forward a
      // client-supplied value upstream where downstream services might trust it.
      continue
    }
    headers[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

function parseBoolean(value, fallback) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function defaultOpenClawInstance() {
  return {
    id: defaultInstanceId,
    label: 'Default local OpenClaw',
    dashboardUrl: defaultDashboardUrl,
    controlUiOrigin: null,
    terminalServerUrl: process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011',
    loopbackOnly: true,
    default: true,
  }
}

function parseOpenClawInstanceRegistry() {
  const fallback = [defaultOpenClawInstance()]
  const raw = process.env.OPENCLAW_INSTANCE_REGISTRY_JSON?.trim()
  if (!raw) return fallback

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback

    const normalized = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null
        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null
        const dashboardUrl = typeof entry.dashboardUrl === 'string' && entry.dashboardUrl.trim() ? entry.dashboardUrl.trim() : null
        if (!id || !dashboardUrl) return null

        return {
          id,
          label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
          dashboardUrl,
          controlUiOrigin: typeof entry.controlUiOrigin === 'string' && entry.controlUiOrigin.trim() ? entry.controlUiOrigin.trim() : null,
          terminalServerUrl: typeof entry.terminalServerUrl === 'string' && entry.terminalServerUrl.trim()
            ? entry.terminalServerUrl.trim()
            : process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011',
          loopbackOnly: parseBoolean(typeof entry.loopbackOnly === 'string' ? entry.loopbackOnly : undefined, entry.loopbackOnly ?? true),
          default: Boolean(entry.default),
        }
      })
      .filter(Boolean)

    if (normalized.length === 0) return fallback
    if (!normalized.some((entry) => entry.id === defaultInstanceId)) {
      normalized.unshift({ ...defaultOpenClawInstance(), default: normalized.some((entry) => entry.default) ? false : true })
    }
    return normalized
  } catch {
    return fallback
  }
}

function parseSandboxInstanceMap() {
  const defaultMap = process.env.MY_ASSISTANT_OPENCLAW_INSTANCE_ID?.trim()
    ? { 'my-assistant': process.env.MY_ASSISTANT_OPENCLAW_INSTANCE_ID.trim() }
    : {}
  const raw = process.env.OPENCLAW_SANDBOX_INSTANCE_MAP_JSON?.trim()
  if (!raw) return defaultMap

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaultMap
    const normalized = Object.entries(parsed).reduce((acc, [sandboxId, instanceId]) => {
      const normalizedSandboxId = typeof sandboxId === 'string' ? sandboxId.trim() : ''
      const normalizedInstanceId = typeof instanceId === 'string' ? instanceId.trim() : ''
      if (normalizedSandboxId && normalizedInstanceId) acc[normalizedSandboxId] = normalizedInstanceId
      return acc
    }, {})
    return Object.keys(normalized).length > 0 ? { ...defaultMap, ...normalized } : defaultMap
  } catch {
    return defaultMap
  }
}

const openClawInstances = parseOpenClawInstanceRegistry()
const openClawSandboxInstanceMap = parseSandboxInstanceMap()

function getDefaultOpenClawInstance() {
  return openClawInstances.find((entry) => entry.default) || openClawInstances[0] || defaultOpenClawInstance()
}

function resolveOpenClawInstance(instanceId) {
  const requested = typeof instanceId === 'string' ? instanceId.trim() : ''
  if (!requested) return getDefaultOpenClawInstance()
  const sandboxInstance = resolveSandboxOpenClawInstance(requested)
  if (sandboxInstance) return sandboxInstance
  return openClawInstances.find((entry) => entry.id === requested) || getDefaultOpenClawInstance()
}

function getMappedOpenClawInstanceId(sandboxId) {
  const requested = typeof sandboxId === 'string' ? sandboxId.trim() : ''
  return requested ? openClawSandboxInstanceMap[requested] || buildSandboxOpenClawInstanceId(requested) : null
}

function hashSandboxId(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

function getSandboxOpenClawPort(sandboxId) {
  return sandboxDashboardPortBase + (hashSandboxId(sandboxId) % sandboxDashboardPortRange)
}

function buildSandboxOpenClawInstanceId(sandboxId) {
  return `sandbox-${getSandboxOpenClawPort(sandboxId)}-${sandboxId}`
}

function resolveSandboxOpenClawInstance(instanceId) {
  const requested = typeof instanceId === 'string' ? instanceId.trim() : ''
  const match = requested.match(/^sandbox-(\d+)-(.+)$/)
  if (!match) return null
  const port = Number.parseInt(match[1], 10)
  if (!Number.isFinite(port)) return null
  return {
    id: requested,
    label: `OpenClaw for ${match[2]}`,
    dashboardUrl: `http://127.0.0.1:${port}/`,
    // The hash port above is the HOST side of the ssh tunnel; in-sandbox the
    // gateway listens on OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT (18789, see
    // openshellHost.ts). Cloud sandboxes allowlist exactly this origin, so
    // keep sending it byte-identical; BYOVPS sandboxes (whose config gateway
    // allowlists a different port) pass via the gateway's local-loopback rule
    // now that copyDashboardWebSocketHeaders strips forwarded headers.
    controlUiOrigin: process.env.OPENCLAW_SANDBOX_CONTROL_UI_ORIGIN
      || `http://127.0.0.1:${Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT || '18789', 10)}`,
    terminalServerUrl: process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011',
    loopbackOnly: true,
    default: false,
  }
}

function resolveDashboardUpstream(req) {
  const incoming = new URL(req.url || '/', `http://${req.headers.host || `${hostname}:${port}`}`)
  const { pathname, searchParams } = incoming

  let requestedInstanceId = null
  let proxyPrefix = legacyDashboardProxyPrefix

  if (pathname.startsWith(instancesProxyPrefix)) {
    const suffixIndex = pathname.indexOf(dashboardProxySuffix, instancesProxyPrefix.length)
    if (suffixIndex !== -1) {
      requestedInstanceId = decodeURIComponent(pathname.slice(instancesProxyPrefix.length, suffixIndex))
      proxyPrefix = `/api/openshell/instances/${encodeURIComponent(requestedInstanceId)}/dashboard/proxy`
    }
  }

  const sandboxId = searchParams.get('sandboxId')
  const mappedInstanceId = getMappedOpenClawInstanceId(sandboxId)
  const resolvedInstance = resolveOpenClawInstance(requestedInstanceId || mappedInstanceId)
  const upstreamHttpUrl = new URL(pathname.startsWith(proxyPrefix) ? pathname.slice(proxyPrefix.length) || '/' : '/', resolvedInstance.dashboardUrl)
  incoming.searchParams.forEach((value, key) => {
    if (key !== 'path' && key !== 'bootstrapUrl') upstreamHttpUrl.searchParams.append(key, value)
  })
  const upstreamWsUrl = new URL(upstreamHttpUrl.toString())
  upstreamWsUrl.protocol = upstreamWsUrl.protocol === 'https:' ? 'wss:' : 'ws:'

  return {
    proxyPrefix,
    upstreamWsUrl,
    controlUiOrigin: resolvedInstance.controlUiOrigin || new URL(resolvedInstance.dashboardUrl).origin,
    instanceId: resolvedInstance.id,
  }
}

function normalizeCloseCode(code) {
  return typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015
    ? code
    : 1000
}

function redactSensitiveUrl(value) {
  try {
    const url = new URL(value.toString())
    for (const key of ['token', 'authToken', 'access_token']) {
      if (url.searchParams.has(key)) url.searchParams.set(key, '<redacted>')
    }
    return url.toString()
  } catch {
    return String(value || '')
  }
}

function withDashboardTokenQuery(upstreamWsUrl, token) {
  const url = new URL(upstreamWsUrl.toString())
  if (token) {
    // The cookie token is server-set by /dashboard/open from a live sandbox
    // probe — trust it over any client-supplied URL ?token=, which the SPA may
    // have cached in localStorage from a previous (now-recreated) sandbox.
    // Without this, a fresh /dashboard/open call refreshes the cookie but the
    // stale URL token still wins and the gateway rejects with token_mismatch.
    url.searchParams.set('token', token)
    url.searchParams.delete('authToken')
  }
  return url
}

function shouldAutoStartTerminalServer() {
  if (/^(0|false|no|off)$/i.test(process.env.TERMINAL_SERVER_AUTOSTART || '')) return false
  if (terminalServerUrl.protocol !== 'http:') return false
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(terminalServerUrl.hostname)
}

async function isTerminalServerReachable() {
  try {
    const response = await fetch(new URL('/healthz', terminalServerUrl), { cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

async function waitForTerminalServer(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isTerminalServerReachable()) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

async function startLocalTerminalServerIfNeeded() {
  if (!shouldAutoStartTerminalServer()) {
    logBridge('terminal-server-autostart-skipped', {
      terminalServerUrl: terminalServerUrl.toString(),
      reason: 'disabled-or-nonlocal',
    })
    return null
  }

  if (await isTerminalServerReachable()) {
    logBridge('terminal-server-existing', { terminalServerUrl: terminalServerUrl.toString() })
    return null
  }

  const child = spawn(process.execPath, ['terminal-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERMINAL_SERVER_HOST: terminalServerUrl.hostname === 'localhost' ? '127.0.0.1' : terminalServerUrl.hostname.replace(/^\[|\]$/g, ''),
      TERMINAL_SERVER_PORT: terminalServerUrl.port || '3011',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  logBridge('terminal-server-autostarted', {
    pid: child.pid,
    terminalServerUrl: terminalServerUrl.toString(),
  })
  registerManagedChild(child)

  child.once('exit', (code, signal) => {
    logBridge('terminal-server-exited', { code, signal })
  })

  if (!await waitForTerminalServer()) {
    logBridge('terminal-server-autostart-not-ready', {
      terminalServerUrl: terminalServerUrl.toString(),
    })
  }

  return child
}

function shouldAutoStartInterSandboxChatSidecar() {
  return !/^(0|false|no|off)$/i.test(process.env.INTER_SANDBOX_CHAT_SIDECAR_AUTOSTART || '')
}

function startInterSandboxChatSidecar() {
  if (!shouldAutoStartInterSandboxChatSidecar()) {
    logBridge('inter-sandbox-chat-sidecar-autostart-skipped', {
      reason: 'disabled',
    })
    return null
  }

  const child = spawn(process.execPath, ['scripts/inter-sandbox-chat-sidecar.mjs'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  logBridge('inter-sandbox-chat-sidecar-autostarted', {
    pid: child.pid,
  })
  registerManagedChild(child)

  child.once('error', (error) => {
    logBridge('inter-sandbox-chat-sidecar-error', {
      reason: error instanceof Error ? error.message : 'spawn failed',
    })
  })
  child.once('exit', (code, signal) => {
    logBridge('inter-sandbox-chat-sidecar-exited', { code, signal })
  })

  return child
}

const app = next({ dev, hostname, port })
// Next.js's NextCustomServer lazily attaches its own 'upgrade' listener to the
// http server on the first request (see node_modules/next/dist/server/next.js
// setupWebSocketHandler). When EventEmitter dispatches an 'upgrade', that
// listener runs alongside ours and destroys the socket, killing our dashboard
// WebSocket bridge ~3 ms after we send 101 Switching Protocols. Setting the
// internal flag prevents Next.js from ever attaching that listener.
app.didWebSocketSetup = true
const handle = app.getRequestHandler()

// Handle the restore endpoint entirely in the custom server to avoid a Next.js 15
// bug where fromNodeNextRequest throws "body disturbed or locked" for large
// multipart uploads — whether the body is unconsumed (original bug) or pre-read
// by us (same error, different cause). Bypassing Next.js routing for this one
// POST endpoint lets us use Node.js streams directly.
const RESTORE_ROUTE_RE = /^\/api\/sandbox\/([^/?#]+)\/restore(?:\?|$)/
const OPENSHELL_BIN_FOR_RESTORE = process.env.OPENSHELL_BIN || '/usr/bin/openshell'
const MAX_RESTORE_FILE_BYTES = Number(process.env.SANDBOX_FILE_TRANSFER_MAX_BYTES) || (128 * 1024 * 1024)
const ALLOWED_SANDBOX_ROOTS = ['/sandbox', '/tmp']

function shellQuoteRestore(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

function collectIncomingBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function execOpenshellForRestore(args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || 'nemoclaw' }
    const child = spawn(OPENSHELL_BIN_FOR_RESTORE, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `openshell ${args.join(' ')} exited ${code}`))
      else resolve(stdout)
    })
    child.on('error', reject)
  })
}

// Mirrors TypeScript resolveSandboxRef: try direct get, then list+match by Id.
async function resolveRestoreSandboxName(sandboxId) {
  const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[mGKHF]/g, '')
  const parseField = (stdout, field) => {
    const m = stripAnsi(stdout).match(new RegExp(`^\\s*${field}\\s*:\\s*(.+)$`, 'mi'))
    return m?.[1]?.trim() ?? null
  }
  // First try direct lookup — works when sandboxId is actually a sandbox name.
  try {
    const stdout = await execOpenshellForRestore(['sandbox', 'get', sandboxId])
    return parseField(stdout, 'Name') || sandboxId
  } catch {
    // Fall through to list-based ID lookup below.
  }
  // List all sandboxes and find the one whose Id matches.
  const listOut = await execOpenshellForRestore(['sandbox', 'list'])
  const names = listOut.trim().split('\n').slice(1)
    .map((l) => stripAnsi(l).trim().split(/\s+/)[0]).filter(Boolean)
  for (const name of names) {
    try {
      const stdout = await execOpenshellForRestore(['sandbox', 'get', name])
      if (parseField(stdout, 'Id') === sandboxId) return parseField(stdout, 'Name') || name
    } catch { /* ignore individual lookup failures */ }
  }
  throw new Error(`sandbox not found: ${sandboxId}`)
}

function runRestoreExec(sandboxName, payload, targetPath, replace) {
  return new Promise((resolve, reject) => {
    const qt = shellQuoteRestore(targetPath)
    const script = [
      `tmp="$(mktemp /tmp/openshell-restore.XXXXXX.tar.gz)"`,
      `cat > "$tmp"`,
      `tar -tzf "$tmp" >/tmp/openshell-restore-list.$$`,
      `tar -tvzf "$tmp" >/tmp/openshell-restore-verbose.$$`,
      `while IFS= read -r e; do case "$e" in ""|/*|../*|*/../*|*"/..") rm -f "$tmp" /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 42;; esac; done < /tmp/openshell-restore-list.$$`,
      `while IFS= read -r e; do case "$e" in [-d]*) :;; *) rm -f "$tmp" /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 43;; esac; done < /tmp/openshell-restore-verbose.$$`,
      `mkdir -p ${qt}`,
      replace ? `find ${qt} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +` : ':',
      `if grep -q '^payload/' /tmp/openshell-restore-list.$$; then tar -xzf "$tmp" -C ${qt} --strip-components=1 --wildcards 'payload/*'; else tar -xzf "$tmp" -C ${qt}; fi`,
      `rm -f "$tmp" /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$`,
    ].join(' && ')
    const env = { ...process.env, OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || 'nemoclaw' }
    const child = spawn(OPENSHELL_BIN_FOR_RESTORE, ['sandbox', 'exec', '-n', sandboxName, '--', 'sh', '-lc', script], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.stdin.write(payload)
    child.stdin.end()
    child.on('close', (code) => {
      if (code === 42) reject(new Error('archive contains unsafe paths'))
      else if (code === 43) reject(new Error('archive contains unsupported entry types'))
      else if (code !== 0) reject(new Error(stderr.trim() || 'failed to restore sandbox archive'))
      else resolve()
    })
    child.on('error', reject)
  })
}

async function handleRestoreRequest(req, res, sandboxId) {
  if (!isAuthenticatedUpgrade(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
    return
  }
  try {
    const rawBody = await collectIncomingBody(req)
    const contentType = req.headers['content-type'] || ''
    let form
    try {
      form = await new Request('http://localhost/__restore', {
        method: 'POST', headers: { 'content-type': contentType }, body: rawBody,
      }).formData()
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `Failed to parse upload: ${e?.message}` }))
      return
    }
    const archiveFile = form.get('archive')
    if (!archiveFile || !(archiveFile instanceof File)) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'archive is required' }))
      return
    }
    const rawTarget = form.get('targetPath')
    const rawReplace = form.get('replace')
    const targetPath = typeof rawTarget === 'string' && rawTarget.trim() ? rawTarget.trim() : '/sandbox'
    const replace = rawReplace === 'true' || rawReplace === '1'
    const normalized = targetPath.startsWith('/') ? targetPath : '/sandbox/' + targetPath
    if (!ALLOWED_SANDBOX_ROOTS.some((r) => normalized === r || normalized.startsWith(r + '/'))) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: 'sandbox path must be under /sandbox or /tmp' }))
      return
    }
    const payload = Buffer.from(await archiveFile.arrayBuffer())
    if (payload.byteLength > MAX_RESTORE_FILE_BYTES) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `archive is too large; max transfer size is ${Math.floor(MAX_RESTORE_FILE_BYTES / 1024 / 1024)} MiB` }))
      return
    }
    let sandboxName
    try {
      sandboxName = await resolveRestoreSandboxName(sandboxId)
    } catch {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: `sandbox not found: ${sandboxId}` }))
      return
    }
    await runRestoreExec(sandboxName, payload, normalized, replace)
    const mode = replace ? 'replace' : 'merge'
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({
      ok: true,
      restored: { sandboxName, archiveName: archiveFile.name, targetPath: normalized, bytes: payload.byteLength, mode },
      note: `Restored ${archiveFile.name} into ${normalized} (${mode}).`,
    }))
  } catch (e) {
    const message = e?.message || 'Failed to restore sandbox backup'
    const status = /required|path|large|unsafe|archive/.test(message) ? 400 : 500
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: message }))
  }
}

await startLocalTerminalServerIfNeeded()
startInterSandboxChatSidecar()
await app.prepare()
const handleUpgrade = typeof app.getUpgradeHandler === 'function'
  ? app.getUpgradeHandler()
  : null

const server = http.createServer((req, res) => {
  const restoreMatch = req.method === 'POST' && RESTORE_ROUTE_RE.exec(req.url || '')
  if (restoreMatch) {
    handleRestoreRequest(req, res, restoreMatch[1]).catch((e) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: e?.message || 'Failed to restore' }))
      }
    })
    return
  }
  handle(req, res)
})
const dashboardWsProxyServer = dashboardWsProxyPort
  ? http.createServer((_, res) => {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('OpenClaw dashboard websocket proxy only')
    })
  : null
const clientWss = new WebSocketServer({ noServer: true })
const dashboardWss = new WebSocketServer({ noServer: true })

function copyDashboardWebSocketHeaders(req, controlUiOrigin) {
  const headers = copyHeaders(req)
  // OpenClaw's gateway treats the presence of ANY forwarded-style header as
  // proof of a proxied (non-local) client and then refuses loopback origins
  // outside its configured allowlist (isLocalDirectRequest in its origin
  // check). This upstream hop is a host-local tunnel the controller has
  // already authenticated, so present it as the direct local client it is.
  for (const key of Object.keys(headers)) {
    const lower = key.toLowerCase()
    if (lower === 'forwarded' || lower === 'x-real-ip' || lower.startsWith('x-forwarded-')) delete headers[key]
  }
  const cookie = filterCookieHeader(req.headers.cookie)
  const dashboardToken = readCookieValue(req.headers.cookie, openClawDashboardTokenCookieName)
  if (cookie) headers.cookie = cookie
  else delete headers.cookie
  headers.origin = controlUiOrigin
  headers.referer = `${controlUiOrigin}/`
  // Cookie wins over any client-supplied Authorization header for the same
  // reason it wins over ?token= in withDashboardTokenQuery: the SPA can hold a
  // stale bearer in localStorage and replay it on WS upgrades, which then
  // overrides the fresh openclaw_dashboard_token cookie set by /dashboard/open.
  if (dashboardToken) headers.authorization = `Bearer ${dashboardToken}`
  return headers
}

function handleDashboardProxyUpgrade(req, socket, head, logEvent) {
  const { upstreamWsUrl, instanceId, controlUiOrigin } = resolveDashboardUpstream(req)
  logBridge(logEvent, {
    path: req.url || '/',
    upstreamUrl: upstreamWsUrl.toString(),
    instanceId,
    remoteAddress: req.socket.remoteAddress || 'unknown',
  })
  dashboardWss.handleUpgrade(req, socket, head, (ws) => {
    dashboardWss.emit('connection', ws, req, { upstreamWsUrl, instanceId, controlUiOrigin })
  })
}

dashboardWss.on('connection', (client, req, context) => {
  const bridgeId = crypto.randomUUID()
  const dashboardToken = readCookieValue(req.headers.cookie, openClawDashboardTokenCookieName)
  const upstreamUrl = withDashboardTokenQuery(context.upstreamWsUrl, dashboardToken)
  const redactedUpstreamUrl = redactSensitiveUrl(upstreamUrl)
  const upstreamHeaders = copyDashboardWebSocketHeaders(req, context.controlUiOrigin)
  const upstream = new WebSocket(upstreamUrl.toString(), {
    headers: upstreamHeaders,
  })
  const pendingClientFrames = []
  let closing = false
  let clientFramesIn = 0
  let upstreamFramesOut = 0
  let upstreamFramesIn = 0
  let clientFramesOut = 0

  logBridge('dashboard-ws-client-connected', {
    bridgeId,
    path: req.url || '/',
    upstreamUrl: redactedUpstreamUrl,
    instanceId: context.instanceId,
    remoteAddress: req.socket.remoteAddress || 'unknown',
    upstreamHeaderKeys: Object.keys(upstreamHeaders).sort().join(','),
    dashboardTokenPresent: Boolean(dashboardToken),
  })

  const flushPendingFrames = () => {
    while (pendingClientFrames.length && upstream.readyState === WebSocket.OPEN) {
      const frame = pendingClientFrames.shift()
      upstreamFramesOut += 1
      upstream.send(frame.data, { binary: frame.isBinary })
    }
    logBridge('dashboard-ws-upstream-open', {
      bridgeId,
      bufferedFramesFlushed: upstreamFramesOut,
      pendingFrames: pendingClientFrames.length,
    })
  }

  const closeClient = (code = 1000, reason) => {
    const safeCode = normalizeCloseCode(code)
    if (client.readyState === WebSocket.OPEN) client.close(safeCode, reason)
    else if (client.readyState === WebSocket.CONNECTING) client.terminate()
  }

  const closeUpstream = (code = 1000, reason) => {
    const safeCode = normalizeCloseCode(code)
    if (upstream.readyState === WebSocket.OPEN) upstream.close(safeCode, reason)
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  }

  const closeBoth = (code = 1000, reason, source = 'unknown') => {
    if (closing) return
    closing = true
    logBridge('dashboard-ws-closing', {
      bridgeId,
      source,
      code,
      reason,
      clientFramesIn,
      upstreamFramesOut,
      upstreamFramesIn,
      clientFramesOut,
      pendingFrames: pendingClientFrames.length,
    })
    closeClient(code, reason)
    closeUpstream(code, reason)
  }

  client.on('message', (data, isBinary) => {
    clientFramesIn += 1
    if (upstream.readyState === WebSocket.OPEN) {
      upstreamFramesOut += 1
      upstream.send(data, { binary: isBinary })
      return
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      pendingClientFrames.push({ data, isBinary })
      return
    }

    closeBoth(1011, 'upstream unavailable', 'dashboard-client-message-no-upstream')
  })

  client.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '')
    closeBoth(code || 1000, reason || undefined, 'dashboard-client-close')
  })
  client.on('error', (error) => closeBoth(1011, error instanceof Error ? error.message : 'dashboard client error', 'dashboard-client-error'))

  upstream.on('open', () => {
    logBridge('dashboard-ws-upstream-connected', {
      bridgeId,
      upstreamUrl: redactedUpstreamUrl,
      instanceId: context.instanceId,
    })
    flushPendingFrames()
  })

  upstream.on('message', (data, isBinary) => {
    upstreamFramesIn += 1
    if (client.readyState === WebSocket.OPEN) {
      clientFramesOut += 1
      client.send(data, { binary: isBinary })
    }
  })

  upstream.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '')
    closeBoth(code || 1000, reason || undefined, 'dashboard-upstream-close')
  })

  upstream.on('error', (error) => {
    logBridge('dashboard-ws-upstream-error', {
      bridgeId,
      upstreamUrl: redactedUpstreamUrl,
      instanceId: context.instanceId,
      reason: error instanceof Error ? error.message : 'dashboard upstream error',
    })
    closeBoth(1011, error instanceof Error ? error.message : 'dashboard upstream error', 'dashboard-upstream-error')
  })
})

function buildRawDashboardUpgradeHeaders(req, upstreamWsUrl, controlUiOrigin) {
  const headers = []
  const dashboardToken = readCookieValue(req.headers.cookie, openClawDashboardTokenCookieName)
  const rawHeaders = new Map()

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    const lowerName = name.toLowerCase()
    if (!rawHeaders.has(lowerName)) rawHeaders.set(lowerName, [])
    rawHeaders.get(lowerName).push({ name, value })
  }

  const firstValue = (name) => rawHeaders.get(name)?.[0]?.value
  const pushRaw = (name) => {
    for (const header of rawHeaders.get(name) || []) {
      headers.push(`${header.name}: ${header.value}`)
    }
  }

  headers.push(`Host: ${upstreamWsUrl.host}`)
  headers.push(`Upgrade: ${firstValue('upgrade') || 'websocket'}`)
  headers.push(`Connection: ${firstValue('connection') || 'Upgrade'}`)
  if (firstValue('sec-websocket-key')) pushRaw('sec-websocket-key')
  if (firstValue('sec-websocket-version')) pushRaw('sec-websocket-version')
  pushRaw('sec-websocket-protocol')
  pushRaw('sec-websocket-extensions')
  headers.push(`Origin: ${controlUiOrigin}`)

  for (const header of rawHeaders.get('cookie') || []) {
    const filteredCookie = filterCookieHeader(header.value)
    if (filteredCookie) headers.push(`Cookie: ${filteredCookie}`)
  }

  if (rawHeaders.has('authorization')) {
    pushRaw('authorization')
  } else if (dashboardToken) {
    headers.push(`Authorization: Bearer ${dashboardToken}`)
  }

  return headers
}

function tunnelDashboardUpgrade(req, socket, head, upstreamWsUrl, instanceId, controlUiOrigin) {
  socket.pause()
  const dashboardToken = readCookieValue(req.headers.cookie, openClawDashboardTokenCookieName)
  const upstreamUrlWithToken = withDashboardTokenQuery(upstreamWsUrl, dashboardToken)
  const redactedUpstreamUrl = redactSensitiveUrl(upstreamUrlWithToken)
  const isSecure = upstreamUrlWithToken.protocol === 'wss:'
  const port = Number(upstreamUrlWithToken.port || (isSecure ? 443 : 80))
  const upstreamSocket = isSecure
    ? tls.connect({ host: upstreamUrlWithToken.hostname, port, servername: upstreamUrlWithToken.hostname })
    : net.connect({ host: upstreamUrlWithToken.hostname, port })
  const upstreamPath = `${upstreamUrlWithToken.pathname || '/'}${upstreamUrlWithToken.search || ''}`
  const requestHead = [
    `GET ${upstreamPath} HTTP/1.1`,
    ...buildRawDashboardUpgradeHeaders(req, upstreamUrlWithToken, controlUiOrigin),
    '',
    '',
  ].join('\r\n')
  let opened = false
  let upstreamBytes = 0
  let clientBytes = 0

  upstreamSocket.once(isSecure ? 'secureConnect' : 'connect', () => {
    opened = true
    upstreamSocket.write(requestHead)
    if (head?.length) upstreamSocket.write(head)
    socket.pipe(upstreamSocket, { end: false })
    upstreamSocket.pipe(socket, { end: false })
    upstreamSocket.resume()
    socket.allowHalfOpen = true
    socket.resume()
    logBridge('dashboard-tunnel-open', {
      path: req.url || '/',
      upstreamUrl: redactedUpstreamUrl,
      instanceId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
      dashboardTokenPresent: Boolean(dashboardToken),
    })
  })

  upstreamSocket.on('data', (chunk) => {
    upstreamBytes += chunk.length
  })

  socket.on('data', (chunk) => {
    clientBytes += chunk.length
  })

  upstreamSocket.on('error', (error) => {
    logBridge('dashboard-tunnel-error', {
      path: req.url || '/',
      upstreamUrl: redactedUpstreamUrl,
      instanceId,
      reason: error instanceof Error ? error.message : 'upstream error',
    })
    if (!opened && !socket.destroyed) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    } else {
      socket.destroy()
    }
  })

  upstreamSocket.on('close', (hadError) => {
    logBridge('dashboard-tunnel-upstream-close', {
      path: req.url || '/',
      upstreamUrl: redactedUpstreamUrl,
      instanceId,
      hadError,
      upstreamBytes,
      clientBytes,
    })
  })

  socket.on('error', (e) => {
    logBridge('dashboard-tunnel-client-error', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      code: e?.code,
      message: e?.message,
      upstreamBytes,
      clientBytes,
    })
    upstreamSocket.destroy()
  })
  socket.on('close', (hadError) => {
    logBridge('dashboard-tunnel-client-close', {
      path: req.url || '/',
      upstreamUrl: redactedUpstreamUrl,
      instanceId,
      hadError,
      upstreamBytes,
      clientBytes,
    })
    upstreamSocket.destroy()
  })
}

clientWss.on('connection', (client, req) => {
  const bridgeId = crypto.randomUUID()
  const upstreamUrl = buildTerminalUpstreamUrl(req)
  const upstream = new WebSocket(upstreamUrl, { headers: copyHeaders(req) })
  const pendingClientFrames = []
  let closing = false
  let clientFramesIn = 0
  let upstreamFramesOut = 0
  let upstreamFramesIn = 0
  let clientFramesOut = 0

  logBridge('client-connected', {
    bridgeId,
    path: req.url || '/',
    upstreamUrl: upstreamUrl.toString(),
    remoteAddress: req.socket.remoteAddress || 'unknown',
  })

  const flushPendingFrames = () => {
    while (pendingClientFrames.length && upstream.readyState === WebSocket.OPEN) {
      const frame = pendingClientFrames.shift()
      upstreamFramesOut += 1
      upstream.send(frame.data, { binary: frame.isBinary })
    }
    logBridge('upstream-open', {
      bridgeId,
      bufferedFramesFlushed: upstreamFramesOut,
      pendingFrames: pendingClientFrames.length,
    })
  }

  const closeClient = (code = 1000, reason) => {
    const safeCode = normalizeCloseCode(code)
    if (client.readyState === WebSocket.OPEN) client.close(safeCode, reason)
    else if (client.readyState === WebSocket.CONNECTING) client.terminate()
  }

  const closeUpstream = (code = 1000, reason) => {
    const safeCode = normalizeCloseCode(code)
    if (upstream.readyState === WebSocket.OPEN) upstream.close(safeCode, reason)
    else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
  }

  const closeBoth = (code = 1000, reason, source = 'unknown') => {
    if (closing) return
    closing = true
    logBridge('bridge-closing', {
      bridgeId,
      source,
      code,
      reason,
      clientFramesIn,
      upstreamFramesOut,
      upstreamFramesIn,
      clientFramesOut,
      pendingFrames: pendingClientFrames.length,
    })
    closeClient(code, reason)
    closeUpstream(code, reason)
  }

  client.on('message', (data, isBinary) => {
    clientFramesIn += 1
    if (upstream.readyState === WebSocket.OPEN) {
      upstreamFramesOut += 1
      upstream.send(data, { binary: isBinary })
      return
    }

    if (upstream.readyState === WebSocket.CONNECTING) {
      pendingClientFrames.push({ data, isBinary })
      return
    }

    closeBoth(1011, 'upstream unavailable', 'client-message-no-upstream')
  })

  client.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '')
    closeBoth(code || 1000, reason || undefined, 'client-close')
  })
  client.on('error', (error) => closeBoth(1011, error instanceof Error ? error.message : 'client error', 'client-error'))

  upstream.on('open', () => {
    flushPendingFrames()
  })

  upstream.on('message', (data, isBinary) => {
    upstreamFramesIn += 1
    if (client.readyState === WebSocket.OPEN) {
      clientFramesOut += 1
      client.send(data, { binary: isBinary })
    }
  })

  upstream.on('close', (code, reasonBuffer) => {
    const reason = Buffer.isBuffer(reasonBuffer) ? reasonBuffer.toString() : String(reasonBuffer || '')
    closeBoth(code || 1000, reason || undefined, 'upstream-close')
  })

  upstream.on('error', (error) => {
    closeBoth(1011, error instanceof Error ? error.message : 'upstream error', 'upstream-error')
  })
})

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith(terminalProxyPath)) {
    if (!isAuthenticatedUpgrade(req) && !isOAuthSandboxUpgradeAuthorized(req)) {
      rejectUnauthorizedUpgrade(req, socket, req.url || '/')
      return
    }
    logBridge('upgrade-accepted', {
      path: req.url || '/',
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      clientWss.emit('connection', ws, req)
    })
    return
  }

  if (
    (req.url || '').startsWith(legacyDashboardProxyPrefix) ||
    (req.url || '').startsWith(instancesProxyPrefix)
  ) {
    if (!isAuthenticatedUpgrade(req) && !isOAuthSandboxUpgradeAuthorized(req)) {
      rejectUnauthorizedUpgrade(req, socket, req.url || '/')
      return
    }
    handleDashboardProxyUpgrade(req, socket, head, 'dashboard-upgrade-accepted')
    return
  }

  logBridge('upgrade-rejected', {
    path: req.url || '/',
    remoteAddress: req.socket.remoteAddress || 'unknown',
  })
  if (handleUpgrade) {
    handleUpgrade(req, socket, head)
    return
  }
  socket.destroy()
})

if (dashboardWsProxyServer) {
  dashboardWsProxyServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith(terminalProxyPath)) {
      if (!isAuthenticatedUpgrade(req) && !isOAuthSandboxUpgradeAuthorized(req)) {
        rejectUnauthorizedUpgrade(req, socket, req.url || '/')
        return
      }
      logBridge('terminal-sidecar-upgrade-accepted', {
        path: req.url || '/',
        remoteAddress: req.socket.remoteAddress || 'unknown',
      })
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        clientWss.emit('connection', ws, req)
      })
      return
    }

    if (
      (req.url || '').startsWith(legacyDashboardProxyPrefix) ||
      (req.url || '').startsWith(instancesProxyPrefix)
    ) {
      if (!isAuthenticatedUpgrade(req) && !isOAuthSandboxUpgradeAuthorized(req)) {
        rejectUnauthorizedUpgrade(req, socket, req.url || '/')
        return
      }
      handleDashboardProxyUpgrade(req, socket, head, 'dashboard-sidecar-upgrade-accepted')
      return
    }

    logBridge('dashboard-sidecar-upgrade-rejected', {
      path: req.url || '/',
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
    socket.destroy()
  })
}

server.listen(port, hostname, () => {
  console.log(`dashboard server listening on http://${hostname}:${port}`)
  logBridge('server-listening', {
    hostname,
    port,
    terminalServerUrl: terminalServerUrl.toString(),
    soleOwnerPath: terminalProxyPath,
    dashboardWebSocketPath: legacyDashboardProxyPrefix,
    dashboardSidecarPort: dashboardWsProxyPort,
  })
})

if (dashboardWsProxyServer) {
  dashboardWsProxyServer.listen(dashboardWsProxyPort, hostname, () => {
    logBridge('dashboard-sidecar-listening', {
      hostname,
      port: dashboardWsProxyPort,
    })
  })
}
