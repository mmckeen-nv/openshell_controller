import { NextResponse } from "next/server"

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MCP_REGISTRY_ASSIST_TIMEOUT_MS || "45000", 10)
const MODEL = process.env.MCP_PREFLIGHT_LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini"
const BASE_URL = (process.env.MCP_PREFLIGHT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.VLLM_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, "")

function extractJsonObject(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("registry assistant did not return JSON")
  return match[0]
}

export async function POST(request: Request) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const body = await request.json().catch(() => ({}))
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
    if (!prompt) throw new Error("registry prompt is required")

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
            content: "Convert a user's MCP registry description into JSON with name, baseUrl, and description. The baseUrl must be the registry origin/root, not the /v0/servers path. Return only JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.error || `registry assistant failed (${response.status})`)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) throw new Error("registry assistant returned an empty response")
    const suggestion = JSON.parse(extractJsonObject(content))
    return NextResponse.json({
      suggestion: {
        name: typeof suggestion?.name === "string" ? suggestion.name : "",
        baseUrl: typeof suggestion?.baseUrl === "string" ? suggestion.baseUrl : "",
        description: typeof suggestion?.description === "string" ? suggestion.description : "",
      },
      model: MODEL,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to assist registry setup"
    return NextResponse.json({ error: message }, { status: /required/.test(message) ? 400 : 502 })
  } finally {
    clearTimeout(timeout)
  }
}
