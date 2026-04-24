import { NextResponse } from 'next/server'
import { getDefaultOpenClawDashboardInstanceId } from '@/app/lib/openshellHost'
import { resolveRuntimeAuthority } from '@/app/lib/runtimeAuthority'

const LEGACY_PROXY_PREFIX = '/api/openshell/dashboard/proxy'
const INSTANCES_PREFIX = '/api/openshell/instances/'
const DASHBOARD_PROXY_SUFFIX = '/dashboard/proxy'
const BOOTSTRAP_SCRIPT_NAME = '__nemoclaw_openclaw_bootstrap.js'
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
  controlUiOrigin: string
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
        controlUiOrigin: authority.openclaw.controlUiOrigin || new URL(authority.openclaw.dashboardUrl).origin,
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
    controlUiOrigin: authority.openclaw.controlUiOrigin || new URL(authority.openclaw.dashboardUrl).origin,
    authorityMode: authority.authorityMode,
    bridgeActive: authority.bridgeActive,
  }
}

function buildTargetUrl(requestUrl: URL) {
  const { proxyPrefix, targetBaseUrl, controlUiOrigin, authorityMode, bridgeActive } = resolveProxyTarget(requestUrl)
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

  return { target, proxyPrefix, controlUiOrigin, authorityMode, bridgeActive }
}

function copyRequestHeaders(request: Request, target: URL, controlUiOrigin: string) {
  const headers = new Headers()

  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase()
    if (
      !HOP_BY_HOP_HEADERS.has(lowerKey) &&
      lowerKey !== 'host' &&
      lowerKey !== 'origin' &&
      lowerKey !== 'referer'
    ) {
      headers.set(key, value)
    }
  })

  headers.set('host', target.host)
  headers.set('origin', controlUiOrigin)
  headers.set('referer', `${controlUiOrigin}/`)
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

function isBootstrapScriptRequest(requestUrl: URL, proxyPrefix: string) {
  return requestUrl.pathname === `${proxyPrefix}/${BOOTSTRAP_SCRIPT_NAME}`
}

function bootstrapScriptResponse(proxyPrefix: string) {
  const wsProxyPort = process.env.OPENCLAW_DASHBOARD_WS_PROXY_PORT?.trim() || '3001'
  const script = `
(() => {
  const proxyPrefix = ${JSON.stringify(proxyPrefix)};
  const wsProxyPort = ${JSON.stringify(wsProxyPort)};
  window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = proxyPrefix;

  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const gatewayHost = wsProxyPort ? window.location.hostname + ':' + wsProxyPort : window.location.host;
    const gatewayUrl = protocol + '//' + gatewayHost + proxyPrefix;
    const settingsKey = 'openclaw.control.settings.v1';
    const tokenPrefix = 'openclaw.control.token.v1:';
    const tokenScope = gatewayUrl;
    const hashParams = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash);
    const token = (hashParams.get('token') || '').trim();
    const rawSettings = window.localStorage.getItem(settingsKey);
    const settings = rawSettings ? JSON.parse(rawSettings) : {};

    settings.gatewayUrl = gatewayUrl;
    window.localStorage.setItem(settingsKey, JSON.stringify(settings));
    window.sessionStorage.removeItem('openclaw.control.token.v1');
    if (token) window.sessionStorage.setItem(tokenPrefix + tokenScope, token);
  } catch {
    // Best-effort compatibility bridge for OpenClaw's persisted UI settings.
  }
})();
`

  return new NextResponse(
    script,
    {
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'application/javascript; charset=utf-8',
      },
    }
  )
}

function injectOpenClawBootstrap(body: string, proxyPrefix: string) {
  const bootstrap = `<script src="${proxyPrefix}/${BOOTSTRAP_SCRIPT_NAME}"></script>`

  return body.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${bootstrap}`)
}

function rewriteHtml(body: string, proxyPrefix: string) {
  const rewritten = body.replace(
    /(<(?:script|img|link)\b[^>]*\s(?:src|href)=)(["'])([^"']+)(["'])/gi,
    (_match, prefix: string, quote: string, value: string, suffix: string) =>
      `${prefix}${quote}${proxiedAssetPath(value, proxyPrefix)}${suffix}`
  )

  return injectOpenClawBootstrap(rewritten, proxyPrefix)
}

export async function proxyOpenClawDashboard(request: Request) {
  const requestUrl = new URL(request.url)
  const resolution = resolveProxyTarget(requestUrl)

  if (isBootstrapScriptRequest(requestUrl, resolution.proxyPrefix)) {
    return bootstrapScriptResponse(resolution.proxyPrefix)
  }

  const { target, proxyPrefix, controlUiOrigin, authorityMode, bridgeActive } = buildTargetUrl(requestUrl)
  const method = request.method.toUpperCase()
  const headers = copyRequestHeaders(request, target, controlUiOrigin)
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
