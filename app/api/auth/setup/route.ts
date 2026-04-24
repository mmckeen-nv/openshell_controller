import { NextRequest, NextResponse } from "next/server"
import {
  createSessionCookieValue,
  getAuthSettings,
  sessionCookieOptions,
  verifyPassword,
  verifyRecoveryToken,
  verifySessionCookieValue,
} from "@/app/lib/controlAuth"
import { updateLocalAuthCredentials } from "@/app/lib/controlAuthConfig"

function validPassword(password: string) {
  return password.length >= 8
}

export async function POST(request: NextRequest) {
  const settings = getAuthSettings()
  const body = await request.json().catch(() => ({}))
  const password = typeof body?.password === "string" ? body.password : ""
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : ""
  const recoveryToken = typeof body?.recoveryToken === "string" ? body.recoveryToken : ""

  if (!validPassword(password)) {
    return NextResponse.json({ ok: false, error: "Password must be at least 8 characters." }, { status: 400 })
  }

  const signedIn = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  const currentPasswordOk = currentPassword ? await verifyPassword(currentPassword) : false
  const recoveryOk = recoveryToken ? await verifyRecoveryToken(recoveryToken) : false
  const firstRun = !settings.configured

  if (!firstRun && !signedIn && !currentPasswordOk && !recoveryOk) {
    return NextResponse.json({ ok: false, error: "Current password or recovery token required." }, { status: 401 })
  }

  const result = await updateLocalAuthCredentials(password)
  const response = NextResponse.json({
    ok: true,
    recoveryToken: result.recoveryToken,
    note: "Password updated. Save the new recovery token from .env.local.",
  })
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptions)
  return response
}
