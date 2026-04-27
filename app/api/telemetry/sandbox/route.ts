import { NextResponse } from "next/server"
import { buildSandboxTelemetry } from "./telemetry"

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    return NextResponse.json(buildSandboxTelemetry(searchParams.get("sandboxId") || "sandbox"))
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch sandbox telemetry' },
      { status: 500 }
    )
  }
}
