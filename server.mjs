import http from 'node:http'
import crypto from 'node:crypto'
import next from 'next'
import { WebSocketServer, WebSocket } from 'ws'

const dev = process.env.NODE_ENV !== 'production'
const hostname = process.env.HOSTNAME || process.env.HOST || '0.0.0.0'
const port = Number(process.env.PORT || 3000)
const terminalServerUrl = new URL(process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011')
const terminalWsProtocol = terminalServerUrl.protocol === 'https:' ? 'wss:' : 'ws:'
const terminalProxyPath = '/api/openshell/terminal/live/ws'
const legacyDashboardProxyPrefix = '/api/openshell/dashboard/proxy'
const instancesProxyPrefix = '/api/openshell/instances/'
const dashboardProxySuffix = '/dashboard/proxy'
const defaultDashboardUrl = process.env.OPENCLAW_DASHBOARD_URL || 'http://127.0.0.1:18789/'
const defaultInstanceId = 'default'

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
    : { 'my-assistant': defaultInstanceId }
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
  return openClawInstances.find((entry) => entry.id === requested) || getDefaultOpenClawInstance()
}

function getMappedOpenClawInstanceId(sandboxId) {
  const requested = typeof sandboxId === 'string' ? sandboxId.trim() : ''
  return requested ? openClawSandboxInstanceMap[requested] || null : null
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
    instanceId: resolvedInstance.id,
  }
}

function normalizeCloseCode(code) {
  return typeof code === 'number' && Number.isInteger(code) && code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015
    ? code
    : 1000
}

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()
const handleUpgrade = typeof app.getUpgradeHandler === 'function'
  ? app.getUpgradeHandler()
  : null

await app.prepare()

const server = http.createServer((req, res) => handle(req, res))
const clientWss = new WebSocketServer({ noServer: true })

function buildRawDashboardUpgradeHeaders(req, upstreamWsUrl) {
  const headers = { ...req.headers }
  const upstreamOrigin = new URL(upstreamWsUrl.toString())
  upstreamOrigin.protocol = upstreamOrigin.protocol === 'wss:' ? 'https:' : 'http:'
  upstreamOrigin.pathname = '/'
  upstreamOrigin.search = ''
  upstreamOrigin.hash = ''
  headers.host = upstreamWsUrl.host
  headers.origin = upstreamOrigin.origin
  return headers
}

function writeBadGateway(socket, reason) {
  if (socket.destroyed) return
  socket.write(
    'HTTP/1.1 502 Bad Gateway\r\n' +
    'Connection: close\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(reason)}\r\n` +
    '\r\n' +
    reason
  )
  socket.destroy()
}

function tunnelDashboardUpgrade(req, socket, head, upstreamWsUrl, instanceId) {
  const upstreamReq = http.request({
    hostname: upstreamWsUrl.hostname,
    port: upstreamWsUrl.port || '80',
    path: `${upstreamWsUrl.pathname}${upstreamWsUrl.search}`,
    method: 'GET',
    headers: buildRawDashboardUpgradeHeaders(req, upstreamWsUrl),
  })

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const responseHead = [
      'HTTP/1.1 101 Switching Protocols',
      ...Object.entries(upstreamRes.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return value.map((entry) => `${key}: ${entry}`)
        return typeof value === 'undefined' ? [] : [`${key}: ${value}`]
      }),
      '',
      '',
    ].join('\r\n')

    socket.write(responseHead)
    if (upstreamHead?.length) socket.write(upstreamHead)
    if (head?.length) upstreamSocket.write(head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
    logBridge('dashboard-tunnel-open', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
  })

  upstreamReq.on('response', (upstreamRes) => {
    writeBadGateway(socket, `OpenClaw dashboard websocket upgrade rejected: ${upstreamRes.statusCode || 502}`)
    upstreamRes.resume()
  })

  upstreamReq.on('error', (error) => {
    logBridge('dashboard-tunnel-error', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      reason: error instanceof Error ? error.message : 'upstream error',
    })
    writeBadGateway(socket, 'OpenClaw dashboard websocket upstream unavailable')
  })

  socket.on('error', () => upstreamReq.destroy())
  upstreamReq.end()
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
    const { upstreamWsUrl, instanceId } = resolveDashboardUpstream(req)
    logBridge('dashboard-upgrade-accepted', {
      path: req.url || '/',
      upstreamUrl: upstreamWsUrl.toString(),
      instanceId,
      remoteAddress: req.socket.remoteAddress || 'unknown',
    })
    tunnelDashboardUpgrade(req, socket, head, upstreamWsUrl, instanceId)
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

server.listen(port, hostname, () => {
  console.log(`dashboard server listening on http://${hostname}:${port}`)
  logBridge('server-listening', {
    hostname,
    port,
    terminalServerUrl: terminalServerUrl.toString(),
    soleOwnerPath: terminalProxyPath,
  })
})
