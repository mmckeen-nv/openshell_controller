import { NextResponse } from "next/server"
export async function POST() {
  return NextResponse.json({
    ok: false,
    code: "GATEWAY_LIFECYCLE_EXTERNAL",
    error: "Automatic gateway trust repair is unavailable because current OpenShell releases do not expose `openshell gateway start`.",
    guidance: "For a NemoClaw-owned gateway, run `nemoclaw onboard` to recover its managed lifecycle. For an externally managed gateway, start it with the owning deployment and then run `openshell gateway select <gateway>`.",
  }, { status: 409 })
}
