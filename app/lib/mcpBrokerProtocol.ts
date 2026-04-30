import { callBrokerServerTool, listBrokerServerTools } from "./mcpBrokerClient"
import { recordLiveTelemetryEvent } from "./liveTelemetry"
import { listAllowedBrokerServers, type SandboxMcpBrokerSession } from "./mcpBrokerStore"
import type { McpServerInstall } from "./mcpServerStore"

export const MCP_PROTOCOL_VERSION = "2024-11-05"
const MAX_TOOL_NAME_LENGTH = 128

type JsonRpcId = string | number | null
type JsonRpcMessage = {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
}

type BrokerToolRef = {
  server: McpServerInstall
  originalToolName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function hasJsonRpcId(message: JsonRpcMessage) {
  return Object.hasOwn(message, "id")
}

export function isBrokerMcpJsonRpcBody(value: unknown) {
  if (Array.isArray(value)) return true
  return isRecord(value) && (
    value.jsonrpc === "2.0" ||
    typeof value.method === "string" ||
    Object.hasOwn(value, "id")
  )
}

function responseFor(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result }
}

export function brokerMcpErrorFor(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  }
}

export function brokerMcpUnauthorizedError() {
  return brokerMcpErrorFor(null, -32001, "MCP broker is unavailable for this sandbox.")
}

function safeToolNamePart(value: string, fallback: string) {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
  return cleaned || fallback
}

function reserveToolName(
  usedNames: Set<string>,
  serverId: string,
  toolName: string,
) {
  const serverPart = safeToolNamePart(serverId, "server")
  const toolPart = safeToolNamePart(toolName, "tool")
  const base = `${serverPart}__${toolPart}`.slice(0, MAX_TOOL_NAME_LENGTH)
  let candidate = base
  let counter = 2
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = `_${counter}`
    candidate = `${base.slice(0, Math.max(1, MAX_TOOL_NAME_LENGTH - suffix.length))}${suffix}`
    counter += 1
  }
  usedNames.add(candidate.toLowerCase())
  return candidate
}

async function loadToolCatalog(session: SandboxMcpBrokerSession) {
  const allowedServers = await listAllowedBrokerServers(session)
  const usedNames = new Set<string>()
  const refs = new Map<string, BrokerToolRef>()
  const tools: Record<string, unknown>[] = []

  for (const server of allowedServers) {
    const serverTools = await listBrokerServerTools(server)
    for (const tool of serverTools) {
      const exposedName = reserveToolName(usedNames, server.id, tool.name)
      refs.set(exposedName, { server, originalToolName: tool.name })
      tools.push({
        name: exposedName,
        title: tool.title || `${server.name}: ${tool.name}`,
        description: [server.name, tool.description].filter(Boolean).join(" - "),
        inputSchema: tool.inputSchema || { type: "object" },
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      })
    }
  }

  return { tools, refs }
}

async function handleBrokerMcpJsonRpcMessage(session: SandboxMcpBrokerSession, message: unknown) {
  if (!isRecord(message)) return brokerMcpErrorFor(null, -32600, "Invalid Request")

  const request = message as JsonRpcMessage
  const id = hasJsonRpcId(request) ? request.id ?? null : null
  const method = typeof request.method === "string" ? request.method : ""
  const isNotification = !hasJsonRpcId(request)
  recordLiveTelemetryEvent("transaction", { sandboxId: session.sandboxId })
  recordLiveTelemetryEvent("mcp_request", { sandboxId: session.sandboxId })

  try {
    switch (method) {
      case "initialize":
        return isNotification ? null : responseFor(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "openshell-control-mcp-broker",
            version: "0.1.0",
          },
        })

      case "notifications/initialized":
      case "notifications/cancelled":
        return null

      case "ping":
        return isNotification ? null : responseFor(id, {})

      case "tools/list": {
        const catalog = await loadToolCatalog(session)
        return isNotification ? null : responseFor(id, { tools: catalog.tools })
      }

      case "tools/call": {
        const params = isRecord(request.params) ? request.params : {}
        const name = typeof params.name === "string" ? params.name : ""
        const toolArguments = isRecord(params.arguments) ? params.arguments : {}
        if (!name) return isNotification ? null : brokerMcpErrorFor(id, -32602, "Tool name is required.")

        const catalog = await loadToolCatalog(session)
        const ref = catalog.refs.get(name)
        if (!ref) {
          return isNotification ? null : responseFor(id, {
            content: [{ type: "text", text: "Requested MCP capability is unavailable." }],
            isError: true,
          })
        }

        const result = await callBrokerServerTool(ref.server, ref.originalToolName, toolArguments)
        return isNotification ? null : responseFor(id, result)
      }

      case "resources/list":
        return isNotification ? null : responseFor(id, { resources: [] })

      case "prompts/list":
        return isNotification ? null : responseFor(id, { prompts: [] })

      default:
        return isNotification ? null : brokerMcpErrorFor(id, -32601, "Method not found.")
    }
  } catch (error) {
    return isNotification ? null : brokerMcpErrorFor(
      id,
      -32000,
      error instanceof Error ? error.message : "MCP broker request failed.",
    )
  }
}

export async function handleBrokerMcpJsonRpcBody(
  session: SandboxMcpBrokerSession,
  body: unknown,
) {
  const isBatch = Array.isArray(body)
  const messages = isBatch ? body : [body]
  const responses = []
  for (const message of messages) {
    const response = await handleBrokerMcpJsonRpcMessage(session, message)
    if (response) responses.push(response)
  }

  if (responses.length === 0) {
    return { status: 202, body: null }
  }

  return {
    status: 200,
    body: isBatch ? responses : responses[0],
  }
}
