import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { HOST_PATH } from "./hostCommands"
import type { McpServerInstall } from "./mcpServerStore"

const MCP_BROKER_REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MCP_BROKER_REQUEST_TIMEOUT_MS || "45000", 10)

function cleanEnv(env: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0),
  )
}

function inheritedEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function transportForServer(server: McpServerInstall) {
  if (server.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(server.command), {
      requestInit: {
        headers: cleanEnv(server.env),
      },
    })
  }

  return new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: {
      ...inheritedEnv(),
      PATH: HOST_PATH,
      ...cleanEnv(server.env),
    },
    stderr: "pipe",
  })
}

async function withMcpClient<T>(server: McpServerInstall, fn: (client: Client) => Promise<T>) {
  const client = new Client({
    name: "openshell-control-mcp-broker",
    version: "0.1.0",
  })
  const transport = transportForServer(server)

  try {
    await client.connect(transport, { timeout: MCP_BROKER_REQUEST_TIMEOUT_MS })
    return await fn(client)
  } finally {
    await client.close().catch(() => null)
  }
}

export async function listBrokerServerTools(server: McpServerInstall) {
  return withMcpClient(server, async (client) => {
    const result = await client.listTools({}, { timeout: MCP_BROKER_REQUEST_TIMEOUT_MS })
    return result.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }))
  })
}

export async function callBrokerServerTool(
  server: McpServerInstall,
  toolName: string,
  toolArguments: Record<string, unknown>,
) {
  return withMcpClient(server, async (client) => (
    client.callTool(
      {
        name: toolName,
        arguments: toolArguments,
      },
      undefined,
      { timeout: MCP_BROKER_REQUEST_TIMEOUT_MS },
    )
  ))
}
