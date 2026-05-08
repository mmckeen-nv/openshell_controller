import { NextRequest, NextResponse } from "next/server"
import { getAuthSettings, sessionCookieOptionsForRequest } from "@/app/lib/controlAuth"

export async function POST(request: NextRequest) {
  const settings = getAuthSettings()
  const response = NextResponse.json({ ok: true })
  response.cookies.set(settings.cookieName, "", {
    ...sessionCookieOptionsForRequest(request),
    maxAge: 0,
  })
  return response
}
