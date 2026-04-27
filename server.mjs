import http from 'node:http'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import next from 'next'
import { WebSocketServer, WebSocket } from 'ws'

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

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
const dashboardWsProxyPort = Number(process.env.OPENCLAW_DASHBOARD_WS_PROXY_PORT || 3001)
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

function isAuthDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.OPENSHELL_CONTROL_AUTH_DISABLED || '')
}

function getAuthSecret() {
  return process.env.OPENSHELL_CONTROL_AUTH_SECRET || process.env.OPENSHELL_CONTROL_PASSWORD || ''
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64').toString('utf8')
}

function hmac(payload) {
  return crypto.createHmac('sha256', getAuthSecret()).update(payload).digest('base64url')
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || '')
  const rightBuffer = Buffer.from(right || '')
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function parseCookies(req) {
  return String(req.headers.cookie || '')
    .split(';')
    .reduce((cookies, part) => {
      const [rawName, ...rawValue] = part.trim().split('=')
      if (!rawName) return cookies
      cookies[rawName] = decodeURIComponent(rawValue.join('=') || '')
      return cookies
    }, {})
}

function isAuthenticatedUpgrade(req) {
  if (isAuthDisabled()) return true
  if (!process.env.OPENSHELL_CONTROL_PASSWORD) return false
  const value = parseCookies(req)[authCookieName]
  if (!value) return false
  const [payload, signature] = value.split('.')
  if (!payload || !signature || !safeEqual(signature, hmac(payload))) return false
  try {
    const parsed = JSON.parse(base64UrlDecode(payload))
    return typeof parsed.exp === 'number' && parsed.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

function rejectUnauthorizedUpgrade(req, socket, path) {
  logBridge('upgrade-auth-rejected', {
    path,
    remoteAddress: req.socket.remoteAddress || 'unknown',
  })
  socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
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
      ['connection', 'host', 'upgrade'].includes(lowerKey) ||
      lowerKey.startsWith('sec-websocket-')
    ) {
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
    controlUiOrigin: process.env.OPENCLAW_SANDBOX_CONTROL_UI_ORIGIN || 'http://127.0.0.1:18789',
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

  child.once('exit', (code, signal) => {
    logBridge('terminal-server-exited', { code, signal })
  })

  const stopChild = () => {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.once('exit', stopChild)
  process.once('SIGINT', () => {
    stopChild()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    stopChild()
    process.exit(143)
  })

  if (!await waitForTerminalServer()) {
    logBridge('terminal-server-autostart-not-ready', {
      terminalServerUrl: terminalServerUrl.toString(),
    })
  }

  return child
}

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()
const handleUpgrade = typeof app.getUpgradeHandler === 'function'
  ? app.getUpgradeHandler()
  : null

await startLocalTerminalServerIfNeeded()
await app.prepare()

const server = http.createServer((req, res) => handle(req, res))
const dashboardWsProxyServer = http.createServer((_, res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('OpenClaw dashboard websocket proxy only')
})
const clientWss = new WebSocketServer({ noServer: true })

function buildRawDashboardUpgradeHeaders(req, upstreamWsUrl, controlUiOrigin) {
  const headers = []
  const seen = new Set()

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    const lowerName = name.toLowerCase()
    seen.add(lowerName)
    if (lowerName === 'host') {
      headers.push(`Host: ${upstreamWsUrl.host}`)
    } else if (lowerName === 'origin') {
      headers.push(`Origin: ${controlUiOrigin}`)
    } else {
      headers.push(`${name}: ${value}`)
    }
  }

  if (!seen.has('host')) headers.push(`Host: ${upstreamWsUrl.host}`)
  if (!seen.has('origin')) headers.push(`Origin: ${controlUiOrigin}`)
  return headers
}

function tunnelDashboardUpgrade(req, socket, head, upstreamWsUrl, instanceId, controlUiOrigin) {
  const isSecure = upstreamWsUrl.protocol === 'wss:'
  const port = Number(upstreamWsUrl.port || (isSecure ? 443 : 80))
  const upstreamSocket = isSecure
    ? tls.connect({ host: upstreamWsUrl.hostname, port, servername: upstreamWsUrl.hostname })
    : net.connect({ host: upstreamWsUrl.hostname, port })
  const upstreamPath = `${upstreamWsUrl.pathname || '/'}${upstreamWsUrl.search || ''}`
  const requestHead = [
    `GET ${upstreamPath} HTTP/1.1`,
    ...buildRawDashboardUpgradeHeaders(req, upstreamWsUrl, controlUiOrigin),
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
    upstreamSocket.resume()
    socket.resume()
    logBridge('dashboard-tunnel-open', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
  })

  upstreamSocket.on('data', (chunk) => {
    upstreamBytes += chunk.length
    if (!socket.destroyed) socket.write(chunk)
  })

  socket.on('data', (chunk) => {
    clientBytes += chunk.length
    if (!upstreamSocket.destroyed) upstreamSocket.write(chunk)
  })

  upstreamSocket.on('error', (error) => {
    logBridge('dashboard-tunnel-error', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
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
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      hadError,
      upstreamBytes,
      clientBytes,
    })
  })

  socket.on('error', () => upstreamSocket.destroy())
  socket.on('close', (hadError) => {
    logBridge('dashboard-tunnel-client-close', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
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
    if (!isAuthenticatedUpgrade(req)) {
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
    if (!isAuthenticatedUpgrade(req)) {
      rejectUnauthorizedUpgrade(req, socket, req.url || '/')
      return
    }
    const { upstreamWsUrl, instanceId, controlUiOrigin } = resolveDashboardUpstream(req)
    logBridge('dashboard-upgrade-accepted', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
    tunnelDashboardUpgrade(req, socket, head, upstreamWsUrl, instanceId, controlUiOrigin)
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

dashboardWsProxyServer.on('upgrade', (req, socket, head) => {
  if ((req.url || '').startsWith(terminalProxyPath)) {
    if (!isAuthenticatedUpgrade(req)) {
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
    if (!isAuthenticatedUpgrade(req)) {
      rejectUnauthorizedUpgrade(req, socket, req.url || '/')
      return
    }
    const { upstreamWsUrl, instanceId, controlUiOrigin } = resolveDashboardUpstream(req)
    logBridge('dashboard-sidecar-upgrade-accepted', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
    tunnelDashboardUpgrade(req, socket, head, upstreamWsUrl, instanceId, controlUiOrigin)
    return
  }

  logBridge('dashboard-sidecar-upgrade-rejected', {
    path: req.url || '/',
    remoteAddress: req.socket.remoteAddress || 'unknown',
  })
  socket.destroy()
})

server.listen(port, hostname, () => {
  console.log(`dashboard server listening on http://${hostname}:${port}`)
  logBridge('server-listening', {
    hostname,
    port,
    terminalServerUrl: terminalServerUrl.toString(),
    soleOwnerPath: terminalProxyPath,
  })
})

dashboardWsProxyServer.listen(dashboardWsProxyPort, hostname, () => {
  logBridge('dashboard-sidecar-listening', {
    hostname,
    port: dashboardWsProxyPort,
  })
})
