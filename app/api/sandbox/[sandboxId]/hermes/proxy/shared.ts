import { NextResponse } from 'next/server'
import { getHermesDashboardPortForSandbox, resolveSandboxRef } from '@/app/lib/openshellHost'

const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
])

function rewriteHtmlForProxy(html: string, proxyBase: string): string {
  // Rewrite absolute-root paths in the original HTML first, before injecting our own tags.
  // Vite builds emit paths like /assets/index.js and /favicon.ico in src/href attributes;
  // the browser resolves these against the origin (bypassing <base href>), so we prepend
  // the proxy base directly.
  let result = html.replace(/((?:src|href|action)=["'])\/(?!\/)/gi, `$1${proxyBase}/`)

  // Inject a fetch/XHR interceptor so the dashboard's JS API calls (e.g. /api/config)
  // are rerouted through the proxy rather than hitting the controller origin.
  // Do this after the regex rewrite so our injected tags are not themselves rewritten.
  const escapedBase = proxyBase.replace(/'/g, "\\'")
  const headInject = `<base href="${proxyBase}/">` +
    `<script>(function(){` +
    `var B='${escapedBase}';` +
    `var F=window.fetch;` +
    `window.fetch=function(u,o){` +
    `if(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(B))u=B+u;` +
    `return F.call(this,u,o);};` +
    `var X=XMLHttpRequest.prototype.open;` +
    `XMLHttpRequest.prototype.open=function(m,u){` +
    `if(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(B))u=B+u;` +
    `return X.apply(this,arguments);};` +
    `})()</script>`
  result = result.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${headInject}`)

  return result
}

export async function proxyHermesDashboard(request: Request, sandboxId: string, upstreamPath: string) {
  const sandbox = await resolveSandboxRef(sandboxId)
  const port = getHermesDashboardPortForSandbox(sandbox.name)
  const normalized = upstreamPath.startsWith('/') ? upstreamPath : `/${upstreamPath}`
  const target = new URL(normalized, `http://127.0.0.1:${port}`)

  const requestUrl = new URL(request.url)
  requestUrl.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value)
  })

  const method = request.method.toUpperCase()
  const headers = new Headers()
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== 'host' && lower !== 'origin' && lower !== 'referer') {
      headers.set(key, value)
    }
  })
  headers.set('host', `127.0.0.1:${port}`)

  const shouldSendBody = !['GET', 'HEAD'].includes(method)
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body: shouldSendBody ? request.body : undefined,
    redirect: 'manual',
    cache: 'no-store',
  }
  if (shouldSendBody) init.duplex = 'half'

  const upstream = await fetch(target.toString(), init)

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value)
    }
  })
  responseHeaders.set('cache-control', 'no-store')

  const proxyBase = `/api/sandbox/${encodeURIComponent(sandboxId)}/hermes/proxy`
  const location = upstream.headers.get('location')
  if (location) {
    responseHeaders.set('location', location.startsWith('/') ? `${proxyBase}${location}` : location)
  }

  const contentType = upstream.headers.get('content-type') || ''
  if (contentType.includes('text/html')) {
    const body = rewriteHtmlForProxy(await upstream.text(), proxyBase)
    responseHeaders.set('content-type', contentType)
    return new NextResponse(body, { status: upstream.status, headers: responseHeaders })
  }

  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders })
}

export function hermesDashboardProxyErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : 'Hermes dashboard proxy error'
  const isConnectionRefused = /ECONNREFUSED|fetch failed|ENOTFOUND/i.test(message)
  return NextResponse.json(
    {
      ok: false,
      error: isConnectionRefused
        ? 'Hermes dashboard is not reachable. Use "Launch Hermes Dashboard" to start it first.'
        : message,
    },
    { status: isConnectionRefused ? 503 : 502 },
  )
}
