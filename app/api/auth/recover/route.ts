import { NextRequest, NextResponse } from "next/server"
import {
  createSessionCookieValue,
  getAuthSettings,
  sessionCookieOptionsForRequest,
  verifyCFAuthorizationJWT,
  verifyRecoveryToken,
  verifySessionCookieValue,
} from "@/app/lib/controlAuth"
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

  const settings = getAuthSettings()
  const signedIn = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  const cfAuth = await verifyCFAuthorizationJWT(request.cookies.get("CF_Authorization")?.value)
  if (cfAuth && !signedIn) {
    return NextResponse.json({ ok: false, error: "Operator session required to reset the password." }, { status: 403 })
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
  // No restart required — see /api/auth/setup for the rationale.
  const response = NextResponse.json({
    ok: true,
    recoveryToken: result.recoveryToken,
    note: "Password reset. Save the new recovery token from .env.local.",
    willRestart: false,
  })
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptionsForRequest(request))
  return response
}
