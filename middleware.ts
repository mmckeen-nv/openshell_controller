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

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

function isAssetPath(pathname: string) {
  return pathname.startsWith("/_next/") || pathname.startsWith("/public/")
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const settings = getAuthSettings()
  if (settings.disabled || isAssetPath(pathname)) {
    if (pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url))
    }
    return NextResponse.next()
  }

  if (isPublicPath(pathname)) {
    if (pathname === "/login" && await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)) {
      return NextResponse.redirect(new URL("/", request.url))
    }
    return NextResponse.next()
  }

  const authenticated = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  if (authenticated) {
    return NextResponse.next()
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ ok: false, error: "Authentication required" }, { status: 401 })
  }

  const loginUrl = new URL("/login", request.url)
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
}
