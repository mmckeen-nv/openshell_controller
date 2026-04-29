import { NextResponse } from "next/server"

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MCP_INSTALL_ASSIST_TIMEOUT_MS || "45000", 10)
const MODEL = process.env.MCP_PREFLIGHT_LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"
const BASE_URL = (process.env.MCP_PREFLIGHT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.VLLM_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, "")

function extractJsonObject(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("install assistant did not return JSON")
  return match[0]
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : []
}

function stringMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key.trim(), String(item ?? "").trim()])
      .filter(([key]) => Boolean(key)),
  )
}

export async function POST(request: Request) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const body = await request.json().catch(() => ({}))
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
    if (!prompt) throw new Error("install prompt is required")

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.MCP_PREFLIGHT_LLM_API_KEY || process.env.OPENAI_API_KEY
          ? { Authorization: `Bearer ${process.env.MCP_PREFLIGHT_LLM_API_KEY || process.env.OPENAI_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You draft install metadata for Model Context Protocol servers.",
              "Return only JSON with name, summary, transport, command, args, env, uploadRuntime, uploadEntryMode, uploadEntrypoint, and notes.",
              "Use transport stdio for local commands and http for streamable HTTP endpoints.",
              "Args must be an array of strings; env must be an object.",
              "If the user describes an uploaded bundle, set upload fields but still provide the most likely runtime and entrypoint.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt,
              current: body?.current || {},
            }),
          },
        ],
      }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.error || `install assistant failed (${response.status})`)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) throw new Error("install assistant returned an empty response")
    const suggestion = JSON.parse(extractJsonObject(content))

    return NextResponse.json({
      suggestion: {
        name: typeof suggestion?.name === "string" ? suggestion.name : "",
        summary: typeof suggestion?.summary === "string" ? suggestion.summary : "",
        transport: suggestion?.transport === "http" ? "http" : "stdio",
        command: typeof suggestion?.command === "string" ? suggestion.command : "",
        args: stringArray(suggestion?.args),
        env: stringMap(suggestion?.env),
        uploadRuntime: typeof suggestion?.uploadRuntime === "string" ? suggestion.uploadRuntime : "",
        uploadEntryMode: ["file", "python-module", "console-script"].includes(suggestion?.uploadEntryMode) ? suggestion.uploadEntryMode : "",
        uploadEntrypoint: typeof suggestion?.uploadEntrypoint === "string" ? suggestion.uploadEntrypoint : "",
        notes: typeof suggestion?.notes === "string" ? suggestion.notes : "",
      },
      model: MODEL,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to assist MCP install"
    return NextResponse.json({ error: message }, { status: /required/.test(message) ? 400 : 502 })
  } finally {
    clearTimeout(timeout)
  }
}
