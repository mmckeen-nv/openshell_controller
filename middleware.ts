import { NextRequest, NextResponse } from "next/server"
import { resolveAuthContext, isAuthDisabled, isAuthConfigured } from "./app/lib/auth/context"
import { isUserAuthorizedForSandbox } from "./app/lib/controlAuth"
import { extractSandboxIdFromUrl } from "./app/lib/auth/policy.mjs"

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/callback",
  "/api/auth/me",
  "/setup-account",
  "/forgot-password",
  "/api/auth/setup",
  "/api/auth/recover",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-32.png",
]
const BROKER_PATHS = [
  "/api/mcp/broker",
]

// Routes where OAuth (IDP-authenticated) users may POST. The route handler
// itself is responsible for verifying the caller is authorized for the
// specific sandbox.
const OAUTH_WRITE_ALLOWED_PATHS = [
  "/api/openshell/terminal/live",
]

function pathMatches(pathname: string, prefixes: string[]) {
  return prefixes.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

function isAssetPath(pathname: string) {
  return pathname.startsWith("/_next/") || pathname.startsWith("/public/")
}

function withSecurityHeaders(response: NextResponse) {
  response.headers.set("x-content-type-options", "nosniff")
  response.headers.set("x-frame-options", "DENY")
  response.headers.set("referrer-policy", "same-origin")
  response.headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()")
  return response
}

function isStateChangingMethod(method: string) {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim() || null
}

function originFromHost(host: string | null, protocol: string) {
  if (!host) return null
  try {
    const normalizedProtocol = protocol.endsWith(":") ? protocol : `${protocol}:`
    return new URL(`${normalizedProtocol}//${host}`).origin
  } catch {
    return null
  }
}

function publicBaseOrigin() {
  if (!process.env.PUBLIC_BASE_URL) return null
  try {
    return new URL(process.env.PUBLIC_BASE_URL).origin
  } catch {
    return null
  }
}

function trustedRequestOrigins(request: NextRequest) {
  const forwardedProto = firstForwardedValue(request.headers.get("x-forwarded-proto"))
  const forwardedHost = firstForwardedValue(request.headers.get("x-forwarded-host"))
  const host = firstForwardedValue(request.headers.get("host"))
  const protocol = forwardedProto || request.nextUrl.protocol || "http:"

  return new Set([
    request.nextUrl.origin,
    originFromHost(host, protocol),
    originFromHost(forwardedHost, protocol),
    publicBaseOrigin(),
  ].filter((origin): origin is string => Boolean(origin)))
}

function hasTrustedOrigin(request: NextRequest) {
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return trustedRequestOrigins(request).has(new URL(origin).origin)
  } catch {
    return false
  }
}

function stripIdentityHeaders(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.delete("x-forwarded-user")
  return headers
}

function withForwardedUser(request: NextRequest, email: string) {
  const headers = stripIdentityHeaders(request)
  headers.set("x-forwarded-user", email)
  return headers
}

function isDashboardProxyNavigation(pathname: string) {
  return (
    pathname.startsWith("/api/openshell/dashboard/proxy") ||
    /^\/api\/openshell\/instances\/[^/]+\/dashboard\/proxy/.test(pathname) ||
    /^\/api\/sandbox\/[^/]+\/hermes\/dashboard\/proxy/.test(pathname)
  )
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  const host = request.headers.get("host") || "localhost:3000"
  const protocol = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol || "http"
  const cleanProtocol = protocol.endsWith(":") ? protocol.slice(0, -1) : protocol
  const baseUrl = `${cleanProtocol}://${host}`

  if (isStateChangingMethod(request.method) && !hasTrustedOrigin(request)) {
    return withSecurityHeaders(NextResponse.json({ ok: false, error: "Untrusted request origin" }, { status: 403 }))
  }

  // Fast path: auth disabled (dev) or static asset — let through with cleaned headers.
  if (isAuthDisabled() || isAssetPath(pathname)) {
    if (pathname === "/login") {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", baseUrl)))
    }
    return withSecurityHeaders(NextResponse.next({ request: { headers: stripIdentityHeaders(request) } }))
  }

  if (pathMatches(pathname, BROKER_PATHS)) {
    return withSecurityHeaders(NextResponse.next({ request: { headers: stripIdentityHeaders(request) } }))
  }

  // Resolve identity once, then dispatch on it.
  const ctx = await resolveAuthContext(request)

  // Public paths bounce the user away from /login if they already have a session,
  // but otherwise let the request through.
  if (pathMatches(pathname, PUBLIC_PATHS)) {
    if (pathname === "/login" && (ctx.kind === "operator" || ctx.kind === "oauth")) {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", baseUrl)))
    }
    return withSecurityHeaders(NextResponse.next({ request: { headers: stripIdentityHeaders(request) } }))
  }

  switch (ctx.kind) {
    case "operator":
    case "disabled":
      return withSecurityHeaders(NextResponse.next({ request: { headers: stripIdentityHeaders(request) } }))

    case "oauth": {
      // OAuth (IDP) users are read-only by default. A small allowlist of POST
      // endpoints (e.g. terminal session allocation) lets them through; the
      // route handler then enforces per-sandbox access from the body.
      const isWriteRequest = isStateChangingMethod(request.method)
      if (isWriteRequest && !pathMatches(pathname, OAUTH_WRITE_ALLOWED_PATHS)) {
        return withSecurityHeaders(NextResponse.json({ ok: false, error: "Forbidden: Operator role required" }, { status: 403 }))
      }

      // Gate URL-identifiable sandbox resources.
      const sandboxId = extractSandboxIdFromUrl(pathname, request.nextUrl.searchParams)
      if (sandboxId && !isUserAuthorizedForSandbox(ctx.email, sandboxId)) {
        if (pathname.startsWith("/api/")) {
          return withSecurityHeaders(NextResponse.json({ ok: false, error: `Forbidden: No access to sandbox ${sandboxId}` }, { status: 403 }))
        }
        return new NextResponse("Forbidden: Access denied to this sandbox", { status: 403 })
      }

      return withSecurityHeaders(NextResponse.next({ request: { headers: withForwardedUser(request, ctx.email) } }))
    }

    case "anonymous":
    default: {
      // Dashboard-proxy paths under /api/ are browser navigations (they serve HTML),
      // so redirect to login like any other UI route instead of returning 401 JSON.
      if (pathname.startsWith("/api/") && !isDashboardProxyNavigation(pathname)) {
        return withSecurityHeaders(NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 }))
      }
      const loginUrl = new URL("/login", baseUrl)
      loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`)
      return withSecurityHeaders(NextResponse.redirect(loginUrl))
    }
  }
}

export const config = {
  // Node runtime so the middleware can read the file-backed sandbox-access store
  // and rotate config without a process restart. Edge would force us to keep
  // sandbox access in a process.env snapshot, which only refreshes on restart.
  runtime: "nodejs",
  matcher: ["/((?!_next/static|_next/image).*)"],
}
