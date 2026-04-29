import { NextResponse } from "next/server"
import { deleteMcpRegistry, listMcpRegistries, saveMcpRegistry } from "@/app/lib/mcpRegistryStore"

export async function GET() {
  try {
    return NextResponse.json({ registries: await listMcpRegistries() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load MCP registries"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === "string" ? body.action : "save"

    if (action === "delete") {
      const registryId = typeof body?.registryId === "string" ? body.registryId : ""
      return NextResponse.json({ deleted: await deleteMcpRegistry(registryId), registries: await listMcpRegistries() })
    }

    const registry = await saveMcpRegistry({
      id: body?.id,
      name: body?.name,
      baseUrl: body?.baseUrl,
      description: body?.description,
    })
    return NextResponse.json({ registry, registries: await listMcpRegistries() })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update MCP registries"
    return NextResponse.json({ error: message }, { status: /required|URL|delete/.test(message) ? 400 : 500 })
  }
}
