import { NextResponse } from "next/server"

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_URL).replace(/\/+$/, "")

type OllamaTag = {
  name?: string
  model?: string
  modified_at?: string
  size?: number
  digest?: string
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
}

function formatBytes(size: unknown) {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export async function GET() {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 2500)

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      cache: "no-store",
      signal: controller.signal,
    })
    const data = await response.json()
    if (!response.ok) {
      throw new Error(data?.error || `Ollama returned HTTP ${response.status}`)
    }

    const models = Array.isArray(data?.models)
      ? data.models.map((item: OllamaTag) => ({
          name: item.model || item.name || "",
          model: item.model || item.name || "",
          modifiedAt: item.modified_at || null,
          size: typeof item.size === "number" ? item.size : null,
          sizeLabel: formatBytes(item.size),
          digest: item.digest || null,
          family: item.details?.family || null,
          parameterSize: item.details?.parameter_size || null,
          quantization: item.details?.quantization_level || null,
        })).filter((item: { name: string }) => item.name)
      : []

    return NextResponse.json({
      ok: true,
      available: true,
      baseUrl: OLLAMA_BASE_URL,
      models,
      count: models.length,
      elapsedMs: Date.now() - startedAt,
    })
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "Ollama probe timed out"
      : error instanceof Error
        ? error.message
        : "Failed to fetch Ollama models"
    return NextResponse.json({
      ok: false,
      available: false,
      baseUrl: OLLAMA_BASE_URL,
      models: [],
      count: 0,
      elapsedMs: Date.now() - startedAt,
      error: message,
    }, { status: 200 })
  } finally {
    clearTimeout(timeout)
  }
}
