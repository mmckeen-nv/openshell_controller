import { NextRequest, NextResponse } from "next/server"
import {
  createSessionCookieValue,
  getAuthSettings,
  sessionCookieOptionsForRequest,
  verifyCFAuthorizationJWT,
  verifyPassword,
  verifyRecoveryToken,
  verifySessionCookieValue,
} from "@/app/lib/controlAuth"
import { updateLocalAuthCredentials } from "@/app/lib/controlAuthConfig"
import { checkRateLimit, clearRateLimit, rateLimitKey, recordRateLimitFailure } from "@/app/lib/rateLimit"

const SETUP_WINDOW_MS = 15 * 60 * 1000
const SETUP_MAX_ATTEMPTS = 8

function validPassword(password: string) {
  return password.length >= 8
}

export async function POST(request: NextRequest) {
  const settings = getAuthSettings()
  const body = await request.json().catch(() => ({}))
  const password = typeof body?.password === "string" ? body.password : ""
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : ""
  const recoveryToken = typeof body?.recoveryToken === "string" ? body.recoveryToken : ""
  const limitKey = rateLimitKey(request, "auth:setup")
  const limit = checkRateLimit(limitKey, SETUP_MAX_ATTEMPTS, SETUP_WINDOW_MS)

  if (limit.limited) {
    return NextResponse.json(
      { ok: false, error: "Too many setup attempts. Try again shortly." },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSeconds) } },
    )
  }

  if (!validPassword(password)) {
    return NextResponse.json({ ok: false, error: "Password must be at least 8 characters." }, { status: 400 })
  }

  const signedIn = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  const cfAuth = await verifyCFAuthorizationJWT(request.cookies.get("CF_Authorization")?.value)
  if (cfAuth && !signedIn) {
    return NextResponse.json({ ok: false, error: "Operator session required to change the password." }, { status: 403 })
  }

  const currentPasswordOk = currentPassword ? await verifyPassword(currentPassword) : false
  const recoveryOk = recoveryToken ? await verifyRecoveryToken(recoveryToken) : false
  const firstRun = !settings.configured

  if (!firstRun && !signedIn && !currentPasswordOk && !recoveryOk) {
    recordRateLimitFailure(limitKey, SETUP_WINDOW_MS)
    return NextResponse.json({ ok: false, error: "Current password or recovery token required." }, { status: 401 })
  }

  clearRateLimit(limitKey)
  const result = await updateLocalAuthCredentials(password)
  // Node-runtime middleware reads process.env (and the file-backed access
  // store) fresh per request, so password rotation no longer requires a
  // process restart. The response includes willRestart for backwards
  // compatibility with clients that branched on it.
  const response = NextResponse.json({
    ok: true,
    recoveryToken: result.recoveryToken,
    note: "Password updated. Save the new recovery token from .env.local.",
    willRestart: false,
  })
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptionsForRequest(request))
  return response
}
