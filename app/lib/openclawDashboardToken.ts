import type { NextResponse } from "next/server"
import { shouldUseSecureSessionCookie } from "./controlAuth"

export const OPENCLAW_DASHBOARD_TOKEN_COOKIE = "openclaw_dashboard_token"
const DASHBOARD_TOKEN_TTL_SECONDS = 12 * 60 * 60

export function dashboardTokenCookieOptions(request: Request, path: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: shouldUseSecureSessionCookie({
      headers: request.headers,
      nextUrl: new URL(request.url),
    }),
    path,
    maxAge: DASHBOARD_TOKEN_TTL_SECONDS,
  }
}

export function extractOpenClawDashboardToken(url: string | null | undefined) {
  if (!url) return null
  try {
    const parsed = new URL(url)
    const hash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash
    return new URLSearchParams(hash).get("token")?.trim() || null
  } catch {
    return null
  }
}

export function setOpenClawDashboardTokenCookie(response: NextResponse, request: Request, path: string, token: string | null) {
  if (!token) return
  response.cookies.set(OPENCLAW_DASHBOARD_TOKEN_COOKIE, token, dashboardTokenCookieOptions(request, path))
}
