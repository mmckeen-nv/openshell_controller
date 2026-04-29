import { NextResponse } from "next/server"
import {
  listAllowedBrokerServers,
  readBrokerToken,
  verifySandboxMcpBrokerToken,
} from "@/app/lib/mcpBrokerStore"
import { callBrokerServerTool } from "@/app/lib/mcpBrokerClient"
import {
  brokerMcpUnauthorizedError,
  handleBrokerMcpJsonRpcBody,
  isBrokerMcpJsonRpcBody,
} from "@/app/lib/mcpBrokerProtocol"

function jsonRpcResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const token = readBrokerToken(request)
    const session = token ? await verifySandboxMcpBrokerToken(token) : null
    const isMcpJsonRpc = isBrokerMcpJsonRpcBody(body)
    if (!session) {
      if (isMcpJsonRpc) return jsonRpcResponse(brokerMcpUnauthorizedError(), 401)
      return NextResponse.json({ ok: false, error: "MCP broker is unavailable for this sandbox." }, { status: 401 })
    }

    if (isMcpJsonRpc) {
      const response = await handleBrokerMcpJsonRpcBody(session, body)
      if (response.body === null) {
        return new Response(null, { status: response.status, headers: { "Cache-Control": "no-store" } })
      }
      return jsonRpcResponse(response.body, response.status)
    }

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
