import { NextResponse } from "next/server"
import { getSandboxPermissionFeed, resolveSandboxNetworkRule } from "@/app/lib/sandboxPermissions"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const feed = await getSandboxPermissionFeed(sandboxId)
    return NextResponse.json({
      ok: true,
      feed,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read permission feed"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const body = await request.json()
    const action = typeof body?.action === "string" ? body.action : ""
    const chunkId = typeof body?.chunkId === "string" ? body.chunkId : ""
    const reason = typeof body?.reason === "string" ? body.reason : ""
    const result = await resolveSandboxNetworkRule(sandboxId, action, chunkId, reason)
    return NextResponse.json({
      ok: true,
      result,
      note: `Network rule ${result.action === "approve" ? "approved" : "rejected"} for ${result.sandboxName}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to resolve permission request"
    return NextResponse.json({ ok: false, error: message }, { status: /unsupported|invalid/.test(message) ? 400 : 500 })
  }
}
