import { NextResponse } from "next/server"
import { buildSandboxTelemetry } from "../telemetry"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    return NextResponse.json(buildSandboxTelemetry(sandboxId))
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch sandbox telemetry" },
      { status: 500 },
    )
  }
}
