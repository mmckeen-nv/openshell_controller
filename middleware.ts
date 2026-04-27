import { NextRequest, NextResponse } from "next/server"
import { getAuthSettings, verifySessionCookieValue } from "./app/lib/controlAuth"

const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
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

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const settings = getAuthSettings()

  if (isStateChangingMethod(request.method) && !hasTrustedOrigin(request)) {
    return withSecurityHeaders(NextResponse.json({ ok: false, error: "Untrusted request origin" }, { status: 403 }))
  }

  if (settings.disabled || isAssetPath(pathname)) {
    if (pathname === "/login") {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", request.url)))
    }
    return withSecurityHeaders(NextResponse.next())
  }

  if (isBrokerPath(pathname)) {
    return withSecurityHeaders(NextResponse.next())
  }

  if (isPublicPath(pathname)) {
    if (pathname === "/login" && await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)) {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", request.url)))
    }
    return withSecurityHeaders(NextResponse.next())
  }

  const authenticated = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  if (authenticated) {
    return withSecurityHeaders(NextResponse.next())
  }

  if (pathname.startsWith("/api/")) {
    return withSecurityHeaders(NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 }))
  }

  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`)
  return withSecurityHeaders(NextResponse.redirect(loginUrl))
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
}
