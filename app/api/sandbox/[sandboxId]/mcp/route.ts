import { NextResponse } from "next/server"
import { brokerBaseUrlForSandbox } from "@/app/lib/mcpBrokerUrl"
import { revokeSandboxMcpManifest, syncSandboxMcpManifest } from "@/app/lib/sandboxMcpManifest"
import { revokeBrokerNetworkAccess, syncBrokerNetworkAccess } from "@/app/lib/sandboxPermissions"

function readSandboxName(request: Request) {
  const requestUrl = new URL(request.url)
  return requestUrl.searchParams.get("sandboxName") || null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    const sandboxName = readSandboxName(request)
    const brokerUrl = await brokerBaseUrlForSandbox(request, { id: sandboxId, name: sandboxName })
    return NextResponse.json({
      ok: true,
      sandboxId,
      path: "/sandbox/openshell_control_mcp.md",
      markdown: [
        "# OpenShell Control MCP Broker",
        "",
        `Sandbox: ${sandboxName || sandboxId}`,
        `Sandbox ID: ${sandboxId}`,
        "",
        "This preview omits the broker token. Use POST to issue and write a live broker config.",
        "",
        `- MCP: \`${brokerUrl}/mcp\``,
        `- Capabilities: \`${brokerUrl}/capabilities\``,
        `- Call: \`${brokerUrl}/call\``,
        "",
        "OpenClaw will receive an `openshell-control` MCP server entry that uses the MCP endpoint.",
        "",
      ].join("\n"),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build MCP broker handoff"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    const body = await request.json().catch(() => ({}))
    const sandboxName = typeof body?.sandboxName === "string" ? body.sandboxName : readSandboxName(request)
    const action = typeof body?.action === "string" ? body.action : "sync"
    const brokerUrl = await brokerBaseUrlForSandbox(request, { id: sandboxId, name: sandboxName })

    if (action === "revoke") {
      const [synced, network] = await Promise.all([
        revokeSandboxMcpManifest({ id: sandboxId, name: sandboxName }),
        revokeBrokerNetworkAccess(sandboxId, brokerUrl),
      ])
      return NextResponse.json({
        ok: true,
        sandboxId,
        synced,
        network,
        note: `Revoked MCP broker config for ${synced.sandboxName}.`,
      })
    }

    const synced = await syncSandboxMcpManifest(
      { id: sandboxId, name: sandboxName },
      { brokerBaseUrl: brokerUrl },
    )
    const network = await syncBrokerNetworkAccess(sandboxId, brokerUrl)
    return NextResponse.json({
      ok: true,
      sandboxId,
      synced,
      network,
      note: `Issued MCP broker config at ${synced.path} and ${synced.openClaw.path}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to issue MCP broker config"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
