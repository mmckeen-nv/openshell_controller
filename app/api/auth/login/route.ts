import { NextRequest, NextResponse } from "next/server"
import { createSessionCookieValue, getAuthSettings, sessionCookieOptions, verifyPassword } from "@/app/lib/controlAuth"
import { checkRateLimit, clearRateLimit, rateLimitKey, recordRateLimitFailure } from "@/app/lib/rateLimit"

const AUTH_WINDOW_MS = 5 * 60 * 1000
const AUTH_MAX_ATTEMPTS = 8

export async function POST(request: NextRequest) {
  const settings = getAuthSettings()
  if (!settings.configured) {
    return NextResponse.json({
      ok: false,
      error: "Dashboard auth is not configured. Set OPENSHELL_CONTROL_PASSWORD and restart the dashboard.",
    }, { status: 503 })
  }

  const body = await request.json().catch(() => ({}))
  const password = typeof body?.password === "string" ? body.password : ""
  const nextPath = typeof body?.next === "string" && body.next.startsWith("/") ? body.next : "/"
  const limitKey = rateLimitKey(request, "auth:login")
  const limit = checkRateLimit(limitKey, AUTH_MAX_ATTEMPTS, AUTH_WINDOW_MS)

  if (limit.limited) {
    return NextResponse.json(
      { ok: false, error: "Too many login attempts. Try again shortly." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    )
  }

  if (!await verifyPassword(password)) {
    recordRateLimitFailure(limitKey, AUTH_WINDOW_MS)
    return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 })
  }

  clearRateLimit(limitKey)
  const response = NextResponse.json({ ok: true, next: nextPath })
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptions)
  return response
}
