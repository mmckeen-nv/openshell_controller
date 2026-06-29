import { NextResponse } from 'next/server'
import { readHermesRemoteAccess } from '@/app/lib/hermesRemote'

// Proxy the in-sandbox Hermes dashboard (NemoClaw v0.17+) through the controller,
// behind the controller's own auth. Unlike the public `web`-mode Traefik route
// (which serves the session-token-bearing SPA HTML past Pangolin), this keeps the
// dashboard gated by controller auth and injects the session token server-side.
//
// Hermes handles path-prefixing natively via X-Forwarded-Prefix (no HTML rewrite),
// and v0.17 authorises WebSockets with single-use ws-tickets, so this route is pure
// HTTP transport; the WS upgrade is proxied in server.mjs. The dashboard is reachable
// from the controller container at http://<bridgeIp>:<port> (the desktop-mode forward).

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'host',
])

function proxyPrefix(sandboxId: string) {
  return `/api/sandbox/${encodeURIComponent(sandboxId)}/hermes/dashboard/proxy`
}

function upstreamBase(access: { bridgeIp?: string; port: number }) {
  const host = access.bridgeIp && access.bridgeIp.trim() ? access.bridgeIp.trim() : '127.0.0.1'
  return `http://${host}:${access.port}`
}

async function proxy(request: Request, sandboxId: string) {
  const access = readHermesRemoteAccess(sandboxId) as (ReturnType<typeof readHermesRemoteAccess> & { bridgeIp?: string }) | null
  if (!access) {
    return NextResponse.json(
      { ok: false, error: `Hermes sandbox '${sandboxId}' is not exposed yet — enable remote access first.` },
      { status: 404 },
    )
  }

  const reqUrl = new URL(request.url)
  const prefix = proxyPrefix(sandboxId)
  const upstreamPath = reqUrl.pathname.startsWith(prefix) ? reqUrl.pathname.slice(prefix.length) || '/' : '/'
  const target = new URL(upstreamPath + reqUrl.search, upstreamBase(access))

  const headers = new Headers()
  request.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value)
  })
  headers.set('host', target.host)
  // Hermes renders the SPA under this prefix natively — no HTML rewriting needed.
  headers.set('x-forwarded-prefix', prefix)
  // Inject the session token server-side so it gates every /api/* call (the browser
  // never needs to hold it). The single-use ws-ticket flow (/api/auth/ws-ticket)
  // rides the same injection, so the WS handshake in server.mjs is pure transport.
  headers.set('x-hermes-session-token', access.token)

  const method = request.method.toUpperCase()
  const hasBody = !['GET', 'HEAD'].includes(method)
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
    cache: 'no-store',
  }
  if (hasBody) init.duplex = 'half'

  let upstream: Response
  try {
    upstream = await fetch(target.toString(), init)
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Hermes dashboard unreachable' },
      { status: 502 },
    )
  }

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) responseHeaders.set(key, value)
  })
  responseHeaders.set('cache-control', 'no-store')
  const location = upstream.headers.get('location')
  if (location && location.startsWith('/')) responseHeaders.set('location', `${prefix}${location}`)

  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders })
}

type Ctx = { params: Promise<{ sandboxId: string; path?: string[] }> }
async function handler(request: Request, { params }: Ctx) {
  const { sandboxId } = await params
  return proxy(request, sandboxId)
}

export const GET = handler
export const POST = handler
export const PUT = handler
export const PATCH = handler
export const DELETE = handler
export const HEAD = handler
export const OPTIONS = handler
