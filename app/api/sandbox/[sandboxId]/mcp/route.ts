import { NextResponse } from "next/server"
import { syncSandboxMcpManifest } from "@/app/lib/sandboxMcpManifest"

function readSandboxName(request: Request) {
  const requestUrl = new URL(request.url)
  return requestUrl.searchParams.get("sandboxName") || null
}

function brokerBaseUrl(request: Request) {
  const origin = new URL(request.url).origin
  return process.env.OPENSHELL_CONTROL_MCP_BROKER_URL || `${origin}/api/mcp/broker`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    const sandboxName = readSandboxName(request)
    const brokerUrl = brokerBaseUrl(request)
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
        `- Capabilities: \`${brokerUrl}/capabilities\``,
        `- Call: \`${brokerUrl}/call\``,
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
    const synced = await syncSandboxMcpManifest(
      { id: sandboxId, name: sandboxName },
      { brokerBaseUrl: brokerBaseUrl(request) },
    )
    return NextResponse.json({
      ok: true,
      sandboxId,
      synced,
      note: `Issued MCP broker config at ${synced.path}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to issue MCP broker config"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
