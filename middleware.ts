import { NextRequest, NextResponse } from "next/server"
import { getAuthSettings, verifySessionCookieValue, verifyCFAuthorizationJWT, isUserAuthorizedForSandbox } from "./app/lib/controlAuth"

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/callback",
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

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

function isBrokerPath(pathname: string) {
  return BROKER_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
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

function getSandboxIdFromRequest(request: NextRequest): string | null {
  const { pathname, searchParams } = request.nextUrl

  // Gate dashboard proxy access by sandbox name (extracted from instance ID format: sandbox-{port}-{name})
  if (pathname.startsWith("/api/openshell/instances/")) {
    const parts = pathname.split("/")
    const instanceId = parts[4]
    if (instanceId) {
      const decodedInstanceId = decodeURIComponent(instanceId)
      const match = decodedInstanceId.match(/^sandbox-(\d+)-(.+)$/)
      if (match) return match[2]
    }
  }

  const querySandboxId = searchParams.get("sandboxId")
  if (querySandboxId) {
    return querySandboxId
  }

  return null
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const settings = getAuthSettings()

  const host = request.headers.get("host") || "localhost:3000"
  const protocol = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol || "http"
  const cleanProtocol = protocol.endsWith(":") ? protocol.slice(0, -1) : protocol
  const baseUrl = `${cleanProtocol}://${host}`

  if (isStateChangingMethod(request.method) && !hasTrustedOrigin(request)) {
    return withSecurityHeaders(NextResponse.json({ ok: false, error: "Untrusted request origin" }, { status: 403 }))
  }

  if (settings.disabled || isAssetPath(pathname)) {
    if (pathname === "/login") {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", baseUrl)))
    }
    return withSecurityHeaders(NextResponse.next())
  }

  if (isBrokerPath(pathname)) {
    return withSecurityHeaders(NextResponse.next())
  }

  // Intercept and validate the MCPAuth CF_Authorization JWT cookie
  const cfAuthCookie = request.cookies.get("CF_Authorization")?.value
  const cfAuthPayload = await verifyCFAuthorizationJWT(cfAuthCookie)
  const cfUserEmail = cfAuthPayload?.email || cfAuthPayload?.sub || null

  if (isPublicPath(pathname)) {
    if (pathname === "/login") {
      const hasOperatorSession = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
      if (hasOperatorSession || cfUserEmail) {
        return withSecurityHeaders(NextResponse.redirect(new URL("/", baseUrl)))
      }
    }
    return withSecurityHeaders(NextResponse.next())
  }

  // 1. Operator Auth Check
  const authenticated = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  if (authenticated) {
    return withSecurityHeaders(NextResponse.next())
  }

  // 2. MCPAuth Auth Check
  if (cfUserEmail) {
    // MCPAuth enterprise users are read-only — block all state-changing methods globally
    const isWriteRequest = !["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())
    if (isWriteRequest) {
      return withSecurityHeaders(NextResponse.json({ ok: false, error: "Forbidden: Operator role required" }, { status: 403 }))
    }

    // Gate access to specific sandbox resources
    const sandboxId = getSandboxIdFromRequest(request)
    if (sandboxId && !isUserAuthorizedForSandbox(cfUserEmail, sandboxId)) {
      if (pathname.startsWith("/api/")) {
        return withSecurityHeaders(NextResponse.json({ ok: false, error: `Forbidden: No access to sandbox ${sandboxId}` }, { status: 403 }))
      }
      return new NextResponse("Forbidden: Access denied to this sandbox", { status: 403 })
    }

    // Forward the authenticated email identity downstream
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set("x-forwarded-user", cfUserEmail)
    return withSecurityHeaders(NextResponse.next({
      request: {
        headers: requestHeaders,
      }
    }))
  }

  // 3. Fallback: unauthenticated
  if (pathname.startsWith("/api/")) {
    return withSecurityHeaders(NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 }))
  }

  const loginUrl = new URL("/login", baseUrl)
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`)
  return withSecurityHeaders(NextResponse.redirect(loginUrl))
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
}

