import { NextResponse } from "next/server"
import { listBrokerServerTools } from "@/app/lib/mcpBrokerClient"
import { listMcpServers } from "@/app/lib/mcpServerStore"

export async function GET() {
  const checkedAt = new Date().toISOString()
  try {
    const inventory = await listMcpServers()
    const enabledServers = inventory.servers.filter((server) => server.enabled)
    const checks = await Promise.all(enabledServers.map(async (server) => {
      const startedAt = Date.now()
      try {
        const tools = await listBrokerServerTools(server)
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          source: server.source,
          command: server.command,
          args: server.args,
          ok: true,
          toolCount: tools.length,
          tools: tools.slice(0, 12).map((tool) => tool.name),
          durationMs: Date.now() - startedAt,
        }
      } catch (error) {
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          source: server.source,
          command: server.command,
          args: server.args,
          ok: false,
          toolCount: 0,
          tools: [],
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : "MCP server health check failed",
        }
      }
    }))

    return NextResponse.json({
      ok: checks.every((check) => check.ok),
      checkedAt,
      installedCount: inventory.servers.length,
      enabledCount: enabledServers.length,
      checks,
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      checkedAt,
      error: error instanceof Error ? error.message : "Failed to check MCP server health",
      checks: [],
    }, { status: 500 })
  }
}
