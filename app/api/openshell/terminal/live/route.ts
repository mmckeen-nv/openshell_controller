import { NextResponse } from 'next/server'
import { inspectSandbox } from '@/app/lib/openshellHost'
import { resolveRuntimeAuthority } from '@/app/lib/runtimeAuthority'

const TERMINAL_SERVER_URL = process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011'
const TERMINAL_WS_PROXY_PATH = '/api/openshell/terminal/live/ws'
const TERMINAL_WS_PROXY_PORT = process.env.TERMINAL_WS_PROXY_PORT || process.env.OPENCLAW_DASHBOARD_WS_PROXY_PORT || '3001'
const PUBLIC_BROWSER_HOST = process.env.PUBLIC_BROWSER_HOST || process.env.PUBLIC_WS_HOST || null
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null

function isNonRoutableHost(candidate: string, protocol = 'http:') {
  const normalized = candidate.trim()
  if (!normalized) return true

  try {
    const parsed = new URL(`${protocol}//${normalized}`)
    return (
      parsed.hostname === '0.0.0.0' ||
      parsed.hostname === '::' ||
      parsed.hostname === '[::]'
    )
  } catch {
    return (
      normalized.startsWith('0.0.0.0') ||
      normalized.startsWith('[::]')
    )
  }
}

function resolveBrowserHost(requestUrl: URL, forwardedHost: string | null) {
  const forwardedCandidate = (forwardedHost && forwardedHost.trim()) || ''
  if (forwardedCandidate && !isNonRoutableHost(forwardedCandidate, requestUrl.protocol)) {
    return forwardedCandidate
  }

  if (PUBLIC_BROWSER_HOST && !isNonRoutableHost(PUBLIC_BROWSER_HOST, requestUrl.protocol)) {
    return PUBLIC_BROWSER_HOST.trim()
  }

  if (PUBLIC_BASE_URL) {
    try {
      const parsed = new URL(PUBLIC_BASE_URL)
      if (!isNonRoutableHost(parsed.host, parsed.protocol)) {
        return parsed.host
      }
    } catch {
      // ignore malformed PUBLIC_BASE_URL
    }
  }

  const requestHostHeader = requestUrl.host
  if (!isNonRoutableHost(requestHostHeader, requestUrl.protocol)) {
    return requestHostHeader
  }

  const hostHeader = requestUrl.hostname
  const requestPort = requestUrl.port
  if (hostHeader && !isNonRoutableHost(hostHeader, requestUrl.protocol)) {
    return requestPort ? `${hostHeader}:${requestPort}` : hostHeader
  }

  return null
}

function getBrowserWebSocketUrl(request: Request, params: {
  sessionId: string
  sandboxId: string
  dashboardSessionId: string
}) {
  const requestUrl = new URL(request.url)
  const forwardedProto = request.headers.get('x-forwarded-proto')
  const forwardedHost = request.headers.get('x-forwarded-host')
  const host = resolveBrowserHost(requestUrl, forwardedHost)
  if (!host) {
    throw new Error('No routable browser host available for terminal websocket URL. Set PUBLIC_BROWSER_HOST or PUBLIC_BASE_URL.')
  }
  const baseProtocol = (forwardedProto && forwardedProto.trim()) || requestUrl.protocol.replace(/:$/, '')
  const protocol = baseProtocol === 'https' ? 'wss:' : 'ws:'
  const websocketHost = new URL(`${protocol}//${host}`)
  websocketHost.port = TERMINAL_WS_PROXY_PORT
  const websocketUrl = new URL(TERMINAL_WS_PROXY_PATH, websocketHost)
  websocketUrl.searchParams.set('sessionId', params.sessionId)
  websocketUrl.searchParams.set('sandboxId', params.sandboxId)
  websocketUrl.searchParams.set('dashboardSessionId', params.dashboardSessionId)
  return websocketUrl.toString()
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const sandboxId = typeof body?.sandboxId === 'string' ? body.sandboxId.trim() : ''
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    const dashboardSessionId = typeof body?.dashboardSessionId === 'string' && body.dashboardSessionId.trim()
      ? body.dashboardSessionId.trim()
      : 'dashboard-host'

    const requestedSandboxId = sandboxId || 'host'

    let inspection = null
    if (sandboxId) {
      try {
        inspection = await inspectSandbox(sandboxId)
      } catch {
        inspection = null
      }
    }

    const authority = resolveRuntimeAuthority({
      sandboxId,
      resolvedSandboxId: inspection?.name || null,
      instanceId: typeof body?.instanceId === 'string' ? body.instanceId.trim() : '',
    })
    const terminalServerUrl = authority.terminalServerUrl || TERMINAL_SERVER_URL
    const resolvedSandboxId = authority.resolvedSandboxId || requestedSandboxId

    const response = await fetch(`${terminalServerUrl}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sandboxId: resolvedSandboxId,
        sessionId,
        dashboardSessionId,
      }),
      cache: 'no-store',
    })

    const result = await response.json()
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: result.error || 'Failed to initialize live terminal session.' }, { status: 502 })
    }

    return NextResponse.json({
      ok: true,
      sessionId: result.sessionId,
      sandboxId: result.sandboxId,
      dashboardSessionId: result.dashboardSessionId || dashboardSessionId,
      replay: result.replay,
      transport: result.transport,
      instanceId: authority.openclaw.id,
      authority: {
        requestedSandboxId: authority.requestedSandboxId,
        resolvedSandboxId: authority.resolvedSandboxId,
        sandboxAuthority: authority.sandboxAuthority,
        requestedInstanceId: authority.requestedInstanceId,
        instanceId: authority.openclaw.id,
        sandboxInstanceId: authority.mappedSandboxInstanceId,
        explicitInstanceOverride: authority.explicitInstanceOverride,
        usedMappedSandboxInstance: authority.usedMappedSandboxInstance,
      },
      sshHostAlias: inspection?.sshHostAlias || null,
      websocketUrl: getBrowserWebSocketUrl(request, {
        sessionId: result.sessionId,
        sandboxId: result.sandboxId,
        dashboardSessionId: result.dashboardSessionId || dashboardSessionId,
      }),
      degraded: !inspection,
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to reach terminal server.',
    }, { status: 500 })
  }
}
