import { NextResponse } from "next/server"
import { listActivity } from "@/app/lib/activityLog"

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "100", 10)
  const entries = await listActivity(Number.isFinite(limit) ? limit : 100)
  return NextResponse.json({ ok: true, entries })
}
