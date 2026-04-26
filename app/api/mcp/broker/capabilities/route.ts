import { NextResponse } from "next/server"
import {
  listAllowedBrokerServers,
  readBrokerToken,
  verifySandboxMcpBrokerToken,
} from "@/app/lib/mcpBrokerStore"
import { listBrokerServerTools } from "@/app/lib/mcpBrokerClient"

export async function GET(request: Request) {
  try {
    const token = readBrokerToken(request)
    const session = token ? await verifySandboxMcpBrokerToken(token) : null
    if (!session) {
      return NextResponse.json({ ok: false, error: "MCP broker is unavailable for this sandbox." }, { status: 401 })
    }

    const allowedServers = await listAllowedBrokerServers(session)
    const servers = await Promise.all(allowedServers.map(async (server) => {
      try {
        const tools = await listBrokerServerTools(server)
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          summary: server.summary,
          available: true,
          tools,
        }
      } catch (error) {
        return {
          id: server.id,
          name: server.name,
          transport: server.transport,
          summary: server.summary,
          available: false,
          tools: [],
          error: error instanceof Error ? error.message : "Failed to inspect MCP server",
        }
      }
    }))

    return NextResponse.json({
      ok: true,
      sandboxId: session.sandboxId,
      servers,
    })
  } catch {
    return NextResponse.json({ ok: false, error: "MCP broker is unavailable for this sandbox." }, { status: 500 })
  }
}

export async function POST(request: Request) {
  return GET(request)
}
