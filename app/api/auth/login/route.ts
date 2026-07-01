import { NextRequest, NextResponse } from "next/server"
import { createSessionCookieValue, getAuthSettings, sessionCookieOptionsForRequest, verifyPassword } from "@/app/lib/controlAuth"
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
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptionsForRequest(request))
  return response
}

// Read IDP coordinates from OAUTH_* env vars, falling back to the legacy
// MCPAUTH_* names so existing .env.local files keep working.
function idpEnv(name: string) {
  const upper = name.toUpperCase()
  return process.env[`OAUTH_${upper}`] || process.env[`MCPAUTH_${upper}`] || ""
}

export async function GET() {
  const loginBase = idpEnv("LOGIN_URL")
  const clientId = idpEnv("CLIENT_ID")
  const redirectUri = idpEnv("CALLBACK_URL")

  let oauthLoginUrl: string | null = null
  if (loginBase && clientId && redirectUri) {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
    })
    oauthLoginUrl = `${loginBase}?${params.toString()}`
  }

  // Returns the URL under both names for one release: the new `oauthLoginUrl`
  // and the historical `mcpAuthLoginUrl`, so a stale cached login page from
  // a previous deploy keeps working.
  return NextResponse.json({
    oauthLoginUrl,
    mcpAuthLoginUrl: oauthLoginUrl,
  })
}

