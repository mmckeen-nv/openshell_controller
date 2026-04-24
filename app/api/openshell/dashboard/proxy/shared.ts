import { NextResponse } from 'next/server'
import { getDefaultOpenClawDashboardInstanceId } from '@/app/lib/openshellHost'
import { resolveRuntimeAuthority } from '@/app/lib/runtimeAuthority'

const LEGACY_PROXY_PREFIX = '/api/openshell/dashboard/proxy'
const INSTANCES_PREFIX = '/api/openshell/instances/'
const DASHBOARD_PROXY_SUFFIX = '/dashboard/proxy'
const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

type ProxyTargetResolution = {
  instanceId: string | null
  proxyPrefix: string
  targetBaseUrl: string
  authorityMode: 'direct-host' | 'bridged-sandbox-map' | 'bridged-instance-override'
  bridgeActive: boolean
}

function normalizeDashboardProxyInstanceId(instanceId: string | null) {
  if (!instanceId) return null
  return instanceId === getDefaultOpenClawDashboardInstanceId() ? null : instanceId
}

function resolveProxyTarget(requestUrl: URL): ProxyTargetResolution {
  const pathname = requestUrl.pathname

  if (pathname.startsWith(INSTANCES_PREFIX)) {
    const suffixIndex = pathname.indexOf(DASHBOARD_PROXY_SUFFIX, INSTANCES_PREFIX.length)
    if (suffixIndex !== -1) {
      const rawInstanceId = pathname.slice(INSTANCES_PREFIX.length, suffixIndex)
      const decodedInstanceId = decodeURIComponent(rawInstanceId)
      const normalizedInstanceId = normalizeDashboardProxyInstanceId(decodedInstanceId)
      const authority = resolveRuntimeAuthority({
        sandboxId: requestUrl.searchParams.get('sandboxId'),
        instanceId: normalizedInstanceId,
      })
      return {
        instanceId: authority.openclaw.id,
        proxyPrefix: `/api/openshell/instances/${encodeURIComponent(decodedInstanceId)}/dashboard/proxy`,
        targetBaseUrl: authority.openclaw.dashboardUrl,
        authorityMode: authority.authorityMode,
        bridgeActive: authority.bridgeActive,
      }
    }
  }

  const authority = resolveRuntimeAuthority({
    sandboxId: requestUrl.searchParams.get('sandboxId'),
  })

  return {
    instanceId: authority.bridgeActive ? authority.openclaw.id : null,
    proxyPrefix: LEGACY_PROXY_PREFIX,
    targetBaseUrl: authority.openclaw.dashboardUrl,
    authorityMode: authority.authorityMode,
    bridgeActive: authority.bridgeActive,
  }
}

function buildTargetUrl(requestUrl: URL) {
  const { proxyPrefix, targetBaseUrl, authorityMode, bridgeActive } = resolveProxyTarget(requestUrl)
  const pathParam = requestUrl.searchParams.get('path')
  const bootstrapUrl = requestUrl.searchParams.get('bootstrapUrl')
  const pathname = requestUrl.pathname.startsWith(proxyPrefix)
    ? requestUrl.pathname.slice(proxyPrefix.length)
    : '/'
  const upstreamPath = pathParam ?? pathname ?? '/'
  const normalizedPath = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`
  const target = bootstrapUrl
    ? new URL(bootstrapUrl)
    : new URL(normalizedPath, targetBaseUrl)

  if (!bootstrapUrl) {
    requestUrl.searchParams.forEach((value, key) => {
      if (key !== 'path') target.searchParams.append(key, value)
    })
  }

  return { target, proxyPrefix, authorityMode, bridgeActive }
}

function copyRequestHeaders(request: Request, target: URL) {
  const headers = new Headers()

  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && key.toLowerCase() !== 'host') {
      headers.set(key, value)
    }
  })

  headers.set('host', target.host)
  return headers
}

function copyResponseHeaders(upstream: Response) {
  const headers = new Headers()

  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value)
    }
  })

  headers.set('cache-control', 'no-store')
  return headers
}

function proxiedAssetPath(value: string, proxyPrefix: string) {
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return value
  }

  const normalized = value.startsWith('./')
    ? value.slice(2)
    : value.startsWith('/')
      ? value.slice(1)
      : value

  return `${proxyPrefix}/${normalized}`
}

function rewriteHtml(body: string, proxyPrefix: string) {
  return body.replace(
    /(<(?:script|img|link)\b[^>]*\s(?:src|href)=)(["'])([^"']+)(["'])/gi,
    (_match, prefix: string, quote: string, value: string, suffix: string) =>
      `${prefix}${quote}${proxiedAssetPath(value, proxyPrefix)}${suffix}`
  )
}

export async function proxyOpenClawDashboard(request: Request) {
  const requestUrl = new URL(request.url)
  const { target, proxyPrefix, authorityMode, bridgeActive } = buildTargetUrl(requestUrl)
  const method = request.method.toUpperCase()
  const headers = copyRequestHeaders(request, target)
  const shouldSendBody = !['GET', 'HEAD'].includes(method)
  const upstreamInit: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body: shouldSendBody ? request.body : undefined,
    redirect: 'manual',
    cache: 'no-store',
  }

  if (shouldSendBody) {
    upstreamInit.duplex = 'half'
  }

  const upstream = await fetch(target.toString(), {
    ...upstreamInit,
  })

  const responseHeaders = copyResponseHeaders(upstream)
  responseHeaders.set('x-openclaw-authority-mode', authorityMode)
  responseHeaders.set('x-openclaw-bridge-active', bridgeActive ? 'true' : 'false')
  responseHeaders.set('x-openclaw-dashboard-bootstrap-contract', 'tokenized-openclaw-dashboard')
  const location = upstream.headers.get('location')
  if (location) {
    responseHeaders.set('location', location.startsWith('/') ? `${proxyPrefix}${location}` : location)
  }
  const contentType = upstream.headers.get('content-type') || 'application/octet-stream'

  if (contentType.includes('text/html')) {
    const body = rewriteHtml(await upstream.text(), proxyPrefix)
    responseHeaders.set('content-type', contentType)
    return new NextResponse(body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

export function proxyErrorResponse(error: unknown) {
  return NextResponse.json(
    {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to proxy OpenClaw dashboard',
    },
    { status: 500 }
  )
}
