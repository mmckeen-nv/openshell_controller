import { restartSandboxGatewayWithNemoClaw } from "./nemoclawCli"
import { writeNativeOpenClawConfigPatch } from "./openClawNativeConfig"

export const OPENSHELL_CONTROL_MCP_SERVER_NAME = "openshell-control"
export const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json"

function normalizeBrokerBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

async function restartNativeGateway(sandboxName: string) {
  const result = await restartSandboxGatewayWithNemoClaw(sandboxName)
  if (!result.ok) {
    throw new Error(
      result.stderr || result.error ||
      "NemoClaw could not verify the native agent gateway restart after updating MCP config",
    )
  }
}

export function buildOpenClawMcpServerConfig(brokerBaseUrl: string, token: string) {
  return {
    transport: "streamable-http",
    url: `${normalizeBrokerBaseUrl(brokerBaseUrl)}/mcp`,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    connectionTimeoutMs: 45000,
  }
}

export async function syncSandboxOpenClawMcpConfig(
  sandboxName: string,
  brokerBaseUrl: string,
  token: string,
) {
  const serverConfig = buildOpenClawMcpServerConfig(brokerBaseUrl, token)

  await writeNativeOpenClawConfigPatch(
    sandboxName,
    { mcp: { servers: { [OPENSHELL_CONTROL_MCP_SERVER_NAME]: serverConfig } } },
    "Failed to apply native OpenClaw MCP config",
  )
  await restartNativeGateway(sandboxName)

  return {
    path: OPENCLAW_CONFIG_PATH,
    serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
    transport: serverConfig.transport,
    url: serverConfig.url,
  }
}

export async function revokeSandboxOpenClawMcpConfig(sandboxName: string) {
  await writeNativeOpenClawConfigPatch(
    sandboxName,
    { mcp: { servers: { [OPENSHELL_CONTROL_MCP_SERVER_NAME]: null } } },
    "Failed to remove native OpenClaw MCP config",
  )
  await restartNativeGateway(sandboxName)

  return {
    path: OPENCLAW_CONFIG_PATH,
    serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
    removed: true,
  }
}
