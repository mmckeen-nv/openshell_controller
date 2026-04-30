import { NextResponse } from "next/server"
import { readLiveTelemetrySnapshot } from "@/app/lib/liveTelemetry"

export async function GET() {
  return NextResponse.json(await readLiveTelemetrySnapshot(), {
    headers: { "Cache-Control": "no-store" },
  })
}
