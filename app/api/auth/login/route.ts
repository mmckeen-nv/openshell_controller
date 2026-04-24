import { NextRequest, NextResponse } from "next/server"
import { createSessionCookieValue, getAuthSettings, sessionCookieOptions, verifyPassword } from "@/app/lib/controlAuth"

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

  if (!await verifyPassword(password)) {
    return NextResponse.json({ ok: false, error: "Invalid password" }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true, next: nextPath })
  response.cookies.set(settings.cookieName, await createSessionCookieValue(), sessionCookieOptions)
  return response
}
