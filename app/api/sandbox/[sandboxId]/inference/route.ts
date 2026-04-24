import { NextResponse } from "next/server"
import {
  getSandboxInferenceConfig,
  saveSandboxInferenceConfig,
} from "@/app/lib/sandboxInferenceStore"

function validateSandboxId(value: string) {
  if (!value || value.length > 128) throw new Error("sandbox id is required")
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error("sandbox id contains unsupported characters")
  }
  return value
}

function parseModels(value: unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const config = await getSandboxInferenceConfig(validateSandboxId(sandboxId))
    return NextResponse.json({ ok: true, config })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch sandbox inference config"
    return NextResponse.json({ ok: false, error: message }, { status: /required|unsupported/.test(message) ? 400 : 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const body = await request.json()
    const provider = typeof body?.provider === "string" ? body.provider.trim() : ""
    const primaryModel = typeof body?.primaryModel === "string" ? body.primaryModel.trim() : ""
    const models = parseModels(body?.models)

    if (!provider) throw new Error("provider is required")
    if (!primaryModel && models.length === 0) throw new Error("at least one model is required")

    const config = await saveSandboxInferenceConfig(validateSandboxId(sandboxId), {
      provider,
      primaryModel: primaryModel || models[0],
      models,
    })
    return NextResponse.json({ ok: true, config })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save sandbox inference config"
    return NextResponse.json({ ok: false, error: message }, { status: /required|unsupported|model/.test(message) ? 400 : 500 })
  }
}
