import { NextResponse } from "next/server"
import { getAuthSettings } from "@/app/lib/controlAuth"

export async function POST() {
  const settings = getAuthSettings()
  const response = NextResponse.json({ ok: true })
  response.cookies.set(settings.cookieName, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  })
  return response
}
