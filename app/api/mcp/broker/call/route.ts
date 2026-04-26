import { NextResponse } from "next/server"
import {
  listAllowedBrokerServers,
  readBrokerToken,
  verifySandboxMcpBrokerToken,
} from "@/app/lib/mcpBrokerStore"
import { callBrokerServerTool } from "@/app/lib/mcpBrokerClient"

export async function POST(request: Request) {
  try {
    const token = readBrokerToken(request)
    const session = token ? await verifySandboxMcpBrokerToken(token) : null
    if (!session) {
      return NextResponse.json({ ok: false, error: "MCP broker is unavailable for this sandbox." }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const requestedServerId = typeof body?.serverId === "string" ? body.serverId : ""
    const toolName = typeof body?.toolName === "string" ? body.toolName : ""
    const toolArguments = body?.arguments && typeof body.arguments === "object" && !Array.isArray(body.arguments)
      ? body.arguments as Record<string, unknown>
      : {}
    const allowedServers = await listAllowedBrokerServers(session)
    const server = allowedServers.find((candidate) => candidate.id === requestedServerId)
    if (!server) {
      return NextResponse.json({ ok: false, error: "Requested MCP capability is unavailable." }, { status: 403 })
    }
    if (!toolName) {
      return NextResponse.json({ ok: false, error: "toolName is required." }, { status: 400 })
    }

    const result = await callBrokerServerTool(server, toolName, toolArguments)

    return NextResponse.json({
      ok: true,
      server: {
        id: server.id,
        name: server.name,
        transport: server.transport,
      },
      toolName,
      result,
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : "MCP broker request failed.",
    }, { status: 500 })
  }
}
