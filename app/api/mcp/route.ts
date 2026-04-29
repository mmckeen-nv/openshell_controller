import { NextResponse } from "next/server"
import {
  installMcpServer,
  listMcpServers,
  setMcpServerEnabled,
  updateMcpServerAccess,
  uninstallMcpServer,
} from "@/app/lib/mcpServerStore"
import { autoSyncSandboxMcpAccess } from "@/app/lib/mcpSandboxAutoSync"

export async function GET() {
  try {
    return NextResponse.json(await listMcpServers())
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load MCP servers"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const action = typeof body?.action === "string" ? body.action : "install"

    if (action === "uninstall") {
      const serverId = typeof body?.serverId === "string" ? body.serverId : ""
      const before = await listMcpServers()
      const server = await uninstallMcpServer(serverId)
      const after = await listMcpServers()
      const sandboxSync = await autoSyncSandboxMcpAccess(request, before.servers, after.servers, [server.id])
      return NextResponse.json({ server, ...after, sandboxSync })
    }

    if (action === "enable" || action === "disable") {
      const serverId = typeof body?.serverId === "string" ? body.serverId : ""
      const before = await listMcpServers()
      const server = await setMcpServerEnabled(serverId, action === "enable")
      const after = await listMcpServers()
      const sandboxSync = await autoSyncSandboxMcpAccess(request, before.servers, after.servers, [server.id])
      return NextResponse.json({
        server,
        ...after,
        sandboxSync,
      })
    }

    if (action === "update-access") {
      const serverId = typeof body?.serverId === "string" ? body.serverId : ""
      const before = await listMcpServers()
      const server = await updateMcpServerAccess(serverId, {
        enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
        accessMode: body?.accessMode,
        allowedSandboxIds: Array.isArray(body?.allowedSandboxIds) ? body.allowedSandboxIds : undefined,
      })
      const after = await listMcpServers()
      const sandboxSync = await autoSyncSandboxMcpAccess(request, before.servers, after.servers, [server.id])
      return NextResponse.json({
        server,
        ...after,
        sandboxSync,
      })
    }

    const before = await listMcpServers()
    const server = await installMcpServer({
      id: body?.id,
      name: body?.name,
      summary: body?.summary,
      websiteUrl: body?.websiteUrl,
      transport: body?.transport,
      command: body?.command,
      args: body?.args,
      env: body?.env,
      tags: body?.tags,
      source: body?.source,
      enabled: body?.enabled,
      accessMode: body?.accessMode,
      allowedSandboxIds: body?.allowedSandboxIds,
    })
    const after = await listMcpServers()
    const sandboxSync = await autoSyncSandboxMcpAccess(request, before.servers, after.servers, [server.id])

    return NextResponse.json({ server, ...after, sandboxSync })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update MCP servers"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
