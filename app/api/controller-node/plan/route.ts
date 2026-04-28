import { NextResponse } from "next/server"
import { buildControllerNodePlan, type ControllerPlanRequest } from "@/app/lib/controllerNodePlan"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ControllerPlanRequest
    return NextResponse.json({ ok: true, ...buildControllerNodePlan(body) })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build controller node plan"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
