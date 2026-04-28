import { NextResponse } from "next/server"
import { listControllerNodes, renameControllerNode, upsertControllerNode } from "@/app/lib/controllerNodeRegistry"

export async function GET() {
  try {
    return NextResponse.json({ nodes: await listControllerNodes() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load controller nodes"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === "string" ? body.action : "upsert"

    if (action === "rename") {
      const node = await renameControllerNode(String(body?.nodeId || ""), String(body?.name || ""))
      return NextResponse.json({ node, nodes: await listControllerNodes() })
    }

    const node = await upsertControllerNode({
      id: body?.id,
      name: body?.name,
      host: body?.host,
      url: body?.url,
      role: body?.role,
    })

    return NextResponse.json({ node, nodes: await listControllerNodes() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update controller nodes"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
