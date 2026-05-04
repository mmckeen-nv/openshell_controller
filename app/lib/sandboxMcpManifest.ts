import { revokeSandboxMcpBrokerSession, rotateSandboxMcpBrokerSession } from "./mcpBrokerStore"
import { resolveSandboxName } from "./sandboxFiles"
import {
  OPENSHELL_CONTROL_MCP_SERVER_NAME,
  syncSandboxOpenClawMcpConfig,
  revokeSandboxOpenClawMcpConfig,
} from "./sandboxOpenClawMcpConfig"
import { repairOpenClawExecApprovalsFile, writeSandboxFilePrivileged } from "./sandboxPrivilegedFiles"

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
      `- MCP: \`${brokerBaseUrl}/mcp\``,
      `- Capabilities: \`${brokerBaseUrl}/capabilities\``,
      `- Call: \`${brokerBaseUrl}/call\``,
      "",
      "## OpenClaw",
      "",
      `OpenShell Control also configures OpenClaw MCP server \`${OPENSHELL_CONTROL_MCP_SERVER_NAME}\` to use the MCP endpoint above.`,
      "",
      "## Authentication",
      "",
      "Send this token as an Authorization bearer token or x-openshell-mcp-token header:",
      "",
      "```",
      token,
      "```",
      "",
      "## Quick Check",
      "",
      "Run this inside the sandbox to verify that you are using the current broker token without pasting it into your shell history:",
      "",
      "```sh",
      "node - <<'NODE'",
      "const fs = require('fs')",
      `const url = ${JSON.stringify(`${brokerBaseUrl}/mcp`)}`,
      "const manifest = fs.readFileSync('/sandbox/openshell_control_mcp.md', 'utf8')",
      "const token = manifest.match(/```\\n(osmcp_[^\\n]+)\\n```/)?.[1]",
      "if (!token) throw new Error('MCP broker token not found in /sandbox/openshell_control_mcp.md')",
      "const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }",
      "fetch(url, {",
      "  method: 'POST',",
      "  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },",
      "  body: JSON.stringify(payload),",
      "})",
      "  .then(async (response) => {",
      "    const body = await response.json()",
      "    console.log(JSON.stringify({ status: response.status, tools: body.result?.tools?.map((tool) => tool.name) || [], error: body.error || null }, null, 2))",
      "  })",
      "NODE",
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
  const sandboxName = sandbox.name || await resolveSandboxName(sandbox.id)
  const uploaded = await writeSandboxFilePrivileged(
    sandboxName,
    SANDBOX_MCP_MANIFEST_PATH,
    Buffer.from(handoff.markdown, "utf8"),
  )
  const openClaw = await syncSandboxOpenClawMcpConfig(
    sandboxName,
    options.brokerBaseUrl,
    handoff.token,
  )
  const execApprovals = await repairOpenClawExecApprovalsFile(sandboxName)

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
    openClaw,
    execApprovals,
    markdown: handoff.markdown,
  }
}

export async function revokeSandboxMcpManifest(sandbox: SandboxRef) {
  const session = await revokeSandboxMcpBrokerSession(sandbox.id)
  const now = new Date().toISOString()
  const markdown = [
    "# OpenShell Control MCP Broker",
    "",
    `Generated: ${now}`,
    `Sandbox: ${sandbox.name || sandbox.id}`,
    `Sandbox ID: ${sandbox.id}`,
    "",
    "MCP access is currently disabled for this sandbox.",
    "",
    "The previous broker token has been revoked. Ask the operator to enable an MCP server and issue a new broker config if MCP access is needed.",
    "",
  ].join("\n")
  const sandboxName = sandbox.name || await resolveSandboxName(sandbox.id)
  const uploaded = await writeSandboxFilePrivileged(
    sandboxName,
    SANDBOX_MCP_MANIFEST_PATH,
    Buffer.from(markdown, "utf8"),
  )
  const openClaw = await revokeSandboxOpenClawMcpConfig(sandboxName)

  return {
    path: uploaded.path,
    sandboxName: uploaded.sandboxName,
    bytes: uploaded.bytes,
    brokerSession: session ? {
      sandboxId: session.sandboxId,
      sandboxName: session.sandboxName,
      enabled: session.enabled,
      rotatedAt: session.rotatedAt,
      expiresAt: session.expiresAt,
    } : null,
    openClaw,
    markdown,
  }
}
