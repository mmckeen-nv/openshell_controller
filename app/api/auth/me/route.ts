import { NextRequest, NextResponse } from "next/server"
import { getAuthSettings, verifySessionCookieValue } from "@/app/lib/controlAuth"

export async function GET(request: NextRequest) {
  const settings = getAuthSettings()
  const operator = await verifySessionCookieValue(request.cookies.get(settings.cookieName)?.value)
  return NextResponse.json({ operator, configured: settings.configured })
}
