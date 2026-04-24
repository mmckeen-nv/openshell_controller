import { NextResponse } from "next/server"
import { applySandboxInferenceProfile } from "@/app/lib/sandboxInferenceApply"

function validateSandboxName(value: string) {
  if (!value || value.length > 63) throw new Error("sandbox name is required")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) throw new Error("invalid sandbox name")
  return value
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const body = await request.json().catch(() => ({}))
    const sandboxName = validateSandboxName(typeof body?.sandboxName === "string" ? body.sandboxName : sandboxId)
    const result = await applySandboxInferenceProfile(sandboxId, sandboxName)

    return NextResponse.json({
      ok: true,
      applied: true,
      sandboxId,
      sandboxName,
      ...result,
      note: "OpenClaw config was patched with the routed inference provider and the OpenShell gateway was pointed at the primary route.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to apply inference config"
    return NextResponse.json({
      ok: false,
      applied: false,
      rebuildRequired: true,
      error: message,
      note: "Live apply failed. Rebuild or recreate the sandbox with this inference profile.",
    }, { status: /required|configured|invalid/.test(message) ? 400 : 500 })
  }
}
