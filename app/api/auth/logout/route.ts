import { NextRequest, NextResponse } from "next/server"
import { getAuthSettings, sessionCookieOptionsForRequest } from "@/app/lib/controlAuth"
import { OAUTH_COOKIE_NAME, LEGACY_OAUTH_COOKIE_NAME } from "@/app/lib/auth/policy.mjs"

export async function POST(request: NextRequest) {
  const settings = getAuthSettings()
  const response = NextResponse.json({ ok: true })
  const clear = { ...sessionCookieOptionsForRequest(request), maxAge: 0 }

  // Operator session.
  response.cookies.set(settings.cookieName, "", clear)
  // OAuth (IDP) session — clear both the new and legacy cookie names so a
  // browser carrying a session minted by an older controller version is
  // properly logged out.
  response.cookies.set(OAUTH_COOKIE_NAME, "", clear)
  response.cookies.set(LEGACY_OAUTH_COOKIE_NAME, "", clear)
  return response
}
