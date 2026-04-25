import { NextRequest, NextResponse } from "next/server"
import { createSessionCookieValue, getAuthSettings, sessionCookieOptions, verifyRecoveryToken } from "@/app/lib/controlAuth"
import { updateLocalAuthCredentials } from "@/app/lib/controlAuthConfig"
import { checkRateLimit, clearRateLimit, rateLimitKey, recordRateLimitFailure } from "@/app/lib/rateLimit"

const RECOVERY_WINDOW_MS = 15 * 60 * 1000
const RECOVERY_MAX_ATTEMPTS = 5

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const token = typeof body?.recoveryToken === "string" ? body.recoveryToken : ""
  const password = typeof body?.password === "string" ? body.password : ""
  const limitKey = rateLimitKey(request, "auth:recover")
  const limit = checkRateLimit(limitKey, RECOVERY_MAX_ATTEMPTS, RECOVERY_WINDOW_MS)

  if (limit.limited) {
    return NextResponse.json(
      { ok: false, error: "Too many recovery attempts. Try again shortly." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    )
  }

  if (password.length < 8) {
    return NextResponse.json({ ok: false, error: "Password must be at least 8 characters." }, { status: 400 })
  }

  if (!await verifyRecoveryToken(token)) {
    recordRateLimitFailure(limitKey, RECOVERY_WINDOW_MS)
    return NextResponse.json({ ok: false, error: "Invalid recovery token." }, { status: 401 })
  }

  clearRateLimit(limitKey)
  const result = await updateLocalAuthCredentials(password)
  const settings = getAuthSettings()
  const response = NextResponse.json({
    ok: true,
    recoveryToken: result.recoveryToken,
    note: "Password reset. Save the new recovery token from .env.local.",
  })
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptions)
  return response
}
