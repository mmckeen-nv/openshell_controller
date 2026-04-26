import { rotateSandboxMcpBrokerSession } from "./mcpBrokerStore"
import { uploadSandboxFile } from "./sandboxFiles"

export const SANDBOX_MCP_MANIFEST_PATH = "/sandbox/openshell_control_mcp.md"

type SandboxRef = {
  id: string
  name?: string | null
}

type BrokerHandoffOptions = {
  brokerBaseUrl: string
  rotateToken?: boolean
}

function normalizeBrokerBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

export async function buildSandboxMcpBrokerHandoff(
  sandbox: SandboxRef,
  options: BrokerHandoffOptions,
) {
  const { session, token } = await rotateSandboxMcpBrokerSession(sandbox.id, sandbox.name)
  const brokerBaseUrl = normalizeBrokerBaseUrl(options.brokerBaseUrl)
  const now = new Date().toISOString()

  return {
    session,
    token,
    markdown: [
      "# OpenShell Control MCP Broker",
      "",
      `Generated: ${now}`,
      `Sandbox: ${sandbox.name || sandbox.id}`,
      `Sandbox ID: ${sandbox.id}`,
      "",
      "This sandbox does not receive a list of MCP servers. MCP access is brokered by OpenShell Control, and the control plane enforces which tools are available on every request.",
      "",
      "## Broker Endpoints",
      "",
      `- Capabilities: \`${brokerBaseUrl}/capabilities\``,
      `- Call: \`${brokerBaseUrl}/call\``,
      "",
      "## Authentication",
      "",
      "Send this token as an Authorization bearer token or x-openshell-mcp-token header:",
      "",
      "```",
      token,
      "```",
      "",
      "## Rules",
      "",
      "- Do not assume any MCP server exists unless the broker returns it as available.",
      "- Do not attempt to connect directly to MCP servers.",
      "- Do not invent credentials. The broker owns server credentials and launch details.",
      "- If access changes, ask the operator to issue a new broker config.",
      "",
    ].join("\n"),
  }
}

export async function syncSandboxMcpManifest(
  sandbox: SandboxRef,
  options: BrokerHandoffOptions,
) {
  const handoff = await buildSandboxMcpBrokerHandoff(sandbox, options)
  const uploaded = await uploadSandboxFile(
    sandbox.id,
    SANDBOX_MCP_MANIFEST_PATH,
    "openshell_control_mcp.md",
    Buffer.from(handoff.markdown, "utf8"),
  )

  return {
    path: uploaded.path,
    sandboxName: uploaded.sandboxName,
    bytes: uploaded.bytes,
    brokerSession: {
      sandboxId: handoff.session.sandboxId,
      sandboxName: handoff.session.sandboxName,
      enabled: handoff.session.enabled,
      rotatedAt: handoff.session.rotatedAt,
      expiresAt: handoff.session.expiresAt,
    },
    markdown: handoff.markdown,
  }
}
