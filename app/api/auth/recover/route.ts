import { NextRequest, NextResponse } from "next/server"
import { createSessionCookieValue, getAuthSettings, sessionCookieOptions, verifyRecoveryToken } from "@/app/lib/controlAuth"
import { updateLocalAuthCredentials } from "@/app/lib/controlAuthConfig"

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}))
  const token = typeof body?.recoveryToken === "string" ? body.recoveryToken : ""
  const password = typeof body?.password === "string" ? body.password : ""

  if (password.length < 8) {
    return NextResponse.json({ ok: false, error: "Password must be at least 8 characters." }, { status: 400 })
  }

  if (!await verifyRecoveryToken(token)) {
    return NextResponse.json({ ok: false, error: "Invalid recovery token." }, { status: 401 })
  }

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
