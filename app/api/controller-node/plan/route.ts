import { NextResponse } from "next/server"
import { buildControllerNodePlan, type ControllerPlanRequest } from "@/app/lib/controllerNodePlan"
import { upsertControllerNode } from "@/app/lib/controllerNodeRegistry"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ControllerPlanRequest
    const plan = buildControllerNodePlan(body)
    await upsertControllerNode({
      id: plan.controller.name,
      name: plan.controller.name,
      host: plan.controller.host,
      url: plan.controller.url,
      role: "controller-node",
    })
    return NextResponse.json({ ok: true, ...plan })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build controller node plan"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
