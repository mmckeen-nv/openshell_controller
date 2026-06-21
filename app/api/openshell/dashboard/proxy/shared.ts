import { NextResponse } from 'next/server'
import { getDefaultOpenClawDashboardInstanceId, probeOpenClawDashboard } from '@/app/lib/openshellHost'
import {
  OPENCLAW_DASHBOARD_TOKEN_COOKIE,
  extractOpenClawDashboardToken,
  setOpenClawDashboardTokenCookie,
} from '@/app/lib/openclawDashboardToken'
import { resolveRuntimeAuthority } from '@/app/lib/runtimeAuthority'

const LEGACY_PROXY_PREFIX = '/api/openshell/dashboard/proxy'
const INSTANCES_PREFIX = '/api/openshell/instances/'
const DASHBOARD_PROXY_SUFFIX = '/dashboard/proxy'
const BOOTSTRAP_SCRIPT_NAME = '__nemoclaw_openclaw_bootstrap.js'
const CONTROL_AUTH_COOKIE_NAME = 'openshell_control_session'
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

function copyRequestHeaders(
  request: Request,
  target: URL,
  controlUiOrigin: string,
  tokenOverride?: string | null,
) {
  const headers = new Headers()
  const dashboardToken = tokenOverride !== undefined
    ? tokenOverride
    : readCookieValue(request.headers.get('cookie'), OPENCLAW_DASHBOARD_TOKEN_COOKIE)

  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase()
    if (
      !HOP_BY_HOP_HEADERS.has(lowerKey) &&
      lowerKey !== 'host' &&
      lowerKey !== 'origin' &&
      lowerKey !== 'referer'
    ) {
      const filteredValue = lowerKey === 'cookie' ? filterCookieHeader(value) : value
      if (filteredValue) headers.set(key, filteredValue)
    }
  })

  headers.set('host', target.host)
  headers.set('origin', controlUiOrigin)
  headers.set('referer', `${controlUiOrigin}/`)
  if (dashboardToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${dashboardToken}`)
  }
  return headers
}

function readCookieValue(value: string | null, name: string) {
  return String(value || '')
    .split(';')
    .map((part) => part.trim())
    .reduce<string | null>((found, part) => {
      if (found || !part.startsWith(`${name}=`)) return found
      try {
        return decodeURIComponent(part.slice(name.length + 1))
      } catch {
        return part.slice(name.length + 1)
      }
    }, null)
}

function filterCookieHeader(value: string) {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${CONTROL_AUTH_COOKIE_NAME}=`) && !part.startsWith(`${OPENCLAW_DASHBOARD_TOKEN_COOKIE}=`))
    .join('; ')
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
  const baseWsUrl = process.env.OPENCLAW_DASHBOARD_BASE_WS_URL?.trim() || process.env.BASE_WS_URL?.trim() || ''
  const wsProxyPort = process.env.OPENCLAW_DASHBOARD_WS_PROXY_PORT?.trim() || ''
  const script = `
(() => {
  const proxyPrefix = ${JSON.stringify(proxyPrefix)};
  const baseWsUrl = ${JSON.stringify(baseWsUrl)};
  const wsProxyPort = ${JSON.stringify(wsProxyPort)};
  window.__OPENCLAW_CONTROL_UI_BASE_PATH__ = proxyPrefix;

  try {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const pageGatewayUrl = protocol + '//' + window.location.host + proxyPrefix;
    const portGatewayUrl = wsProxyPort ? protocol + '//' + window.location.hostname + ':' + wsProxyPort + proxyPrefix : '';
    const normalizeGatewayUrl = (value) => {
      const raw = (value || '').trim();
      if (!raw) return '';
      try {
        const parsed = new URL(raw, window.location.href);
        if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
        if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return '';
        parsed.hash = '';
        if (parsed.pathname === '/' || parsed.pathname === '') {
          parsed.pathname = proxyPrefix;
        } else {
          parsed.pathname = parsed.pathname.replace(/\\/+$/, '') || '/';
        }
        return parsed.toString();
      } catch {
        return '';
      }
    };
    const configuredGatewayUrl = normalizeGatewayUrl(baseWsUrl);
    const defaultGatewayUrl = configuredGatewayUrl || portGatewayUrl || pageGatewayUrl;
    const settingsKey = 'openclaw.control.settings.v1';
    const settingsPrefix = 'openclaw.control.settings.v1:';
    const tokenKey = 'openclaw.control.token.v1';
    const tokenPrefix = 'openclaw.control.token.v1:';
    const hashParams = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash);
    const gatewayUrl = normalizeGatewayUrl(hashParams.get('gatewayUrl')) || defaultGatewayUrl;
    const token = (hashParams.get('token') || '').trim();
    const storageScope = (value) => {
      try {
        const parsed = new URL(value, window.location.href);
        const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\\/+$/, '') || parsed.pathname;
        return parsed.protocol + '//' + parsed.host + path;
      } catch {
        return value;
      }
    };
    const uniqueScopes = (values) => Array.from(new Set(values.map(storageScope).filter(Boolean)));
    const gatewayScopes = uniqueScopes([gatewayUrl, configuredGatewayUrl, portGatewayUrl, pageGatewayUrl]);
    const settingsKeys = gatewayScopes.map((scope) => settingsPrefix + scope);
    const readSettings = () => {
      for (const key of [...settingsKeys, settingsPrefix + 'default', settingsKey]) {
        try {
          const raw = window.localStorage.getItem(key);
          if (!raw) continue;
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch {}
      }
      return {};
    };
    const settings = readSettings();

    // Purge stale scoped settings for other gateway URLs so OpenClaw does not
    // detect a URL change and show the "Change Gateway URL" confirmation modal.
    try {
      const keysToRemove = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && k.startsWith(settingsPrefix) && !settingsKeys.includes(k) && k !== settingsPrefix + 'default' && k !== settingsKey) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) window.localStorage.removeItem(k);
    } catch {}

    const effectiveGatewayUrl = token
      ? gatewayUrl + (gatewayUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
      : gatewayUrl;
    settings.gatewayUrl = effectiveGatewayUrl;
    const serializedSettings = JSON.stringify(settings);
    window.localStorage.setItem(settingsKey, serializedSettings);
    for (const key of settingsKeys) window.localStorage.setItem(key, serializedSettings);
    window.sessionStorage.removeItem(tokenKey);
    // Token-scope cleanup: the SPA writes sessionStorage[tokenPrefix + <scope>]
    // for both the wss:// gatewayUrl scope AND an https:// page-origin scope
    // derived from window.location. After multiple failed dashboard opens (eg
    // the BYOVPS doctor-rotation race in #2478), these scoped keys accumulate
    // stale tokens that the SPA replays in the application-level WS connect
    // frame -- our server.mjs cookie-wins fix only covers the WS handshake,
    // not the in-frame token, so a stale sessionStorage token reaches the
    // gateway and triggers "Auth did not match". Wipe ANY existing
    // tokenPrefix:<scope> key whose scope path matches this proxyPrefix, then
    // write the fresh hash token under our known gatewayScopes.
    try {
      const sessionKeysToWipe = [];
      for (let i = 0; i < window.sessionStorage.length; i++) {
        const k = window.sessionStorage.key(i);
        if (k && k.startsWith(tokenPrefix) && k.includes(proxyPrefix)) {
          sessionKeysToWipe.push(k);
        }
      }
      for (const k of sessionKeysToWipe) window.sessionStorage.removeItem(k);
    } catch {}
    if (token) {
      for (const scope of gatewayScopes) window.sessionStorage.setItem(tokenPrefix + scope, token);
      // Also write under the https:// (page-origin) scope so the SPA's own
      // sessionStorage lookup keyed off window.location finds the fresh token.
      try {
        const pageScope = window.location.protocol + '//' + window.location.host + proxyPrefix;
        window.sessionStorage.setItem(tokenPrefix + pageScope, token);
      } catch {}
    }
  } catch {
    // Best-effort compatibility bridge for OpenClaw's persisted UI settings.
  }

  // Auto-confirm the "Change Gateway URL" modal — this modal appears when OpenClaw detects
  // a URL change between sandbox sessions, but we always trust the URL set by this proxy.
  try {
    const interval = setInterval(() => {
      if (!document.body.textContent?.includes('Change Gateway URL')) return;
      const buttons = document.querySelectorAll('button');
      for (const btn of buttons) {
        if (btn.textContent?.trim() === 'Confirm') {
          btn.click();
          clearInterval(interval);
          break;
        }
      }
    }, 100);
    setTimeout(() => clearInterval(interval), 10000);
  } catch {}
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

  let upstream = await fetch(target.toString(), {
    ...upstreamInit,
  })

  // Self-heal stale dashboard token: when a sandbox is deleted and recreated with
  // the same name, the openclaw_dashboard_token cookie still holds the previous
  // sandbox's bearer. Upstream then rejects every request with 401/403. Re-probe
  // the live sandbox for the current token, retry once, and refresh the cookie
  // so subsequent calls (including the WS upgrade) use the new value.
  let refreshedToken: string | null = null
  if (
    (upstream.status === 401 || upstream.status === 403) &&
    !shouldSendBody
  ) {
    const probe = await probeOpenClawDashboard(resolution.instanceId)
    const candidate = extractOpenClawDashboardToken(probe.bootstrapUrl)
    if (candidate) {
      const retryHeaders = copyRequestHeaders(request, target, controlUiOrigin, candidate)
      const retry = await fetch(target.toString(), {
        ...upstreamInit,
        headers: retryHeaders,
      })
      if (retry.ok) {
        upstream = retry
        refreshedToken = candidate
      }
    }
  }

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
    const htmlResponse = new NextResponse(body, {
      status: upstream.status,
      headers: responseHeaders,
    })
    if (refreshedToken) setOpenClawDashboardTokenCookie(htmlResponse, request, proxyPrefix, refreshedToken)
    return htmlResponse
  }

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  })
  if (refreshedToken) setOpenClawDashboardTokenCookie(response, request, proxyPrefix, refreshedToken)
  return response
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
