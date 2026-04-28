import { NextResponse } from "next/server"
import { preflightMcpServer } from "@/app/lib/mcpPreflight"
import { listMcpServers, type McpServerInstall } from "@/app/lib/mcpServerStore"

function normalizeServer(body: any, installed?: McpServerInstall | null): McpServerInstall {
  const now = new Date().toISOString()
  const server = installed || body || {}
  return {
    id: String(body?.id || server.id || body?.serverId || "preflight-server"),
    name: String(body?.name || server.name || body?.id || body?.serverId || "Preflight Server"),
    summary: String(body?.summary || server.summary || ""),
    websiteUrl: typeof body?.websiteUrl === "string" ? body.websiteUrl : server.websiteUrl,
    transport: body?.transport === "http" || server.transport === "http" ? "http" : "stdio",
    command: String(body?.command || server.command || ""),
    args: Array.isArray(body?.args) ? body.args.map(String) : Array.isArray(server.args) ? server.args.map(String) : [],
    env: body?.env && typeof body.env === "object" && !Array.isArray(body.env) ? body.env : server.env || {},
    tags: Array.isArray(body?.tags) ? body.tags.map(String) : Array.isArray(server.tags) ? server.tags.map(String) : ["custom"],
    installedAt: server.installedAt || now,
    updatedAt: now,
    source: body?.source === "catalog" || body?.source === "registry" || body?.source === "custom" ? body.source : server.source || "custom",
    enabled: true,
    accessMode: "disabled",
    allowedSandboxIds: [],
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    let installed: McpServerInstall | null = null
    if (typeof body?.serverId === "string" && body.serverId.trim()) {
      const inventory = await listMcpServers()
      installed = inventory.servers.find((server) => server.id === body.serverId.trim()) || null
      if (!installed) throw new Error("MCP server is not installed")
    }

    const server = normalizeServer(body, installed)
    if (!server.command) throw new Error("server command is required")
    const preflight = await preflightMcpServer(server)
    return NextResponse.json({ ok: preflight.ok, serverId: server.id, preflight })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to preflight MCP server"
    return NextResponse.json({ ok: false, error: message }, { status: /required|installed/.test(message) ? 400 : 500 })
  }
}
