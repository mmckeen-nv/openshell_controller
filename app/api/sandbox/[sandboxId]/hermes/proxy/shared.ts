import { NextResponse } from 'next/server'
import { getHermesDashboardPortForSandbox, resolveSandboxRef } from '@/app/lib/openshellHost'

const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding', 'connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
])

function injectBaseTag(html: string, proxyBase: string) {
  const base = `<base href="${proxyBase}/">`
  return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${base}`)
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
    const body = injectBaseTag(await upstream.text(), proxyBase)
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
