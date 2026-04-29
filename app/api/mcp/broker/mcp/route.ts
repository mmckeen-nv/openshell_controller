import { NextResponse } from "next/server"
import {
  readBrokerToken,
  verifySandboxMcpBrokerToken,
} from "@/app/lib/mcpBrokerStore"
import {
  brokerMcpUnauthorizedError,
  handleBrokerMcpJsonRpcBody,
  MCP_PROTOCOL_VERSION,
} from "@/app/lib/mcpBrokerProtocol"

function jsonRpcResponse(payload: unknown, status = 200) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  })
}

export async function POST(request: Request) {
  const parsedBody = await request.json().catch(() => null)
  const token = readBrokerToken(request)
  const session = token ? await verifySandboxMcpBrokerToken(token) : null
  if (!session) {
    return jsonRpcResponse(brokerMcpUnauthorizedError(), 401)
  }

  const response = await handleBrokerMcpJsonRpcBody(session, parsedBody)
  if (response.body === null) {
    return new Response(null, { status: response.status, headers: { "Cache-Control": "no-store" } })
  }

  return jsonRpcResponse(response.body, response.status)
}

export async function GET(request: Request) {
  const token = readBrokerToken(request)
  const session = token ? await verifySandboxMcpBrokerToken(token) : null
  if (!session) {
    return jsonRpcResponse(brokerMcpUnauthorizedError(), 401)
  }
  return jsonRpcResponse({
    ok: true,
    endpoint: "mcp",
    protocol: MCP_PROTOCOL_VERSION,
    note: "POST MCP JSON-RPC messages to this endpoint.",
  })
}
