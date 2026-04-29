import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { resolveOpenAiCompatibleBaseUrl, resolvePrimaryInferenceModel } from "./inferenceModel"
import { getSandboxInferenceConfig } from "./sandboxInferenceStore"
import type { McpPreflightResult } from "./mcpPreflight"
import type { McpServerInstall } from "./mcpServerStore"

export type McpPreflightRepairChange = {
  type: "file" | "launch"
  path?: string
  summary: string
}

export type McpPreflightRepairResult = {
  attempted: boolean
  ok: boolean
  provider: "openai-compatible"
  model: string
  baseUrl: string
  summary: string
  changes: McpPreflightRepairChange[]
  error?: string
  updatedServer?: Pick<McpServerInstall, "command" | "args" | "env">
}

type RepairContext = {
  uploadRoot: string
  projectRoot: string
  server: McpServerInstall
  preflight: McpPreflightResult
  dependencyLogs?: string[]
  sandboxId?: string | null
}

type LlmRepairResponse = {
  summary?: string
  files?: Array<{ path?: string; content?: string; summary?: string }>
  launch?: {
    command?: string
    args?: string[]
    env?: Record<string, string>
    summary?: string
  }
}

const MAX_CONTEXT_FILE_BYTES = Number.parseInt(process.env.MCP_PREFLIGHT_REPAIR_MAX_FILE_BYTES || String(40 * 1024), 10)
const MAX_CONTEXT_FILES = Number.parseInt(process.env.MCP_PREFLIGHT_REPAIR_MAX_FILES || "18", 10)
const MAX_REPAIR_FILE_BYTES = Number.parseInt(process.env.MCP_PREFLIGHT_REPAIR_MAX_OUTPUT_FILE_BYTES || String(512 * 1024), 10)
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.MCP_PREFLIGHT_REPAIR_TIMEOUT_MS || "60000", 10)
const MCP_SERVER_SPEC_PATH = path.join(process.cwd(), "mcp_server_specs.md")

function relativeInside(root: string, candidate: string) {
  const fullPath = path.resolve(root, candidate)
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("repair path must stay inside the uploaded server")
  }
  return fullPath
}

function normalizeRepairPath(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "")
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("repair file path must be relative to the uploaded server")
  }
  return normalized
}

function isLikelyUsefulFile(filePath: string) {
  if (/(^|\/)(node_modules|\.venv|\.git|dist|build|__pycache__)(\/|$)/.test(filePath)) return false
  return /\.(py|js|mjs|cjs|ts|json|toml|txt|md|yaml|yml)$/i.test(filePath)
    || /(^|\/)(requirements\.txt|package\.json|pyproject\.toml)$/.test(filePath)
}

async function collectFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name)
    const relative = path.relative(root, fullPath).replace(/\\/g, "/")
    if (entry.isDirectory()) {
      if (/(^|\/)(node_modules|\.venv|\.git|dist|build|__pycache__)(\/|$)/.test(relative)) continue
      files.push(...await collectFiles(root, fullPath))
    } else if (entry.isFile()) {
      if (!isLikelyUsefulFile(relative)) continue
      files.push(relative)
    }
  }
  return files
}

async function readContextFiles(root: string) {
  const files = (await collectFiles(root)).slice(0, MAX_CONTEXT_FILES)
  const context: Array<{ path: string; content: string; truncated: boolean }> = []
  for (const file of files) {
    const fullPath = relativeInside(root, file)
    const stats = await stat(fullPath).catch(() => null)
    if (!stats || stats.size > MAX_CONTEXT_FILE_BYTES * 2) continue
    const content = await readFile(fullPath, "utf8").catch(() => "")
    context.push({
      path: file,
      content: content.length > MAX_CONTEXT_FILE_BYTES ? content.slice(0, MAX_CONTEXT_FILE_BYTES) : content,
      truncated: content.length > MAX_CONTEXT_FILE_BYTES,
    })
  }
  return context
}

async function readMcpServerSpec() {
  return await readFile(MCP_SERVER_SPEC_PATH, "utf8").catch(() => [
    "Uploaded MCP servers must initialize through the MCP broker and list tools successfully.",
    "Python uploads must use a per-server .venv and local dependency installation.",
    "Repairs must stay inside the uploaded server directory.",
  ].join("\n"))
}

async function resolveRepairRoute(sandboxId?: string | null) {
  let explicitModel = ""
  if (sandboxId) {
    const config = await getSandboxInferenceConfig(sandboxId)
    const enabled = config.routes.filter((route) => route.enabled)
    const primary = enabled.find((route) => route.id === config.primaryRouteId) || enabled[0]
    explicitModel = primary?.model || ""
  }
  return {
    model: await resolvePrimaryInferenceModel(explicitModel),
    baseUrl: resolveOpenAiCompatibleBaseUrl(),
  }
}

function extractJsonObject(value: string) {
  const trimmed = value.trim()
  if (trimmed.startsWith("{")) return trimmed
  const match = trimmed.match(/\{[\s\S]*\}/)
  if (!match) throw new Error("repair model did not return JSON")
  return match[0]
}

async function requestRepairPlan(context: RepairContext, files: Awaited<ReturnType<typeof readContextFiles>>) {
  const route = await resolveRepairRoute(context.sandboxId)
  if (!route.model) throw new Error("No primary inference model is configured")
  const mcpServerSpec = await readMcpServerSpec()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${route.baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(process.env.MCP_PREFLIGHT_LLM_API_KEY || process.env.OPENAI_API_KEY
          ? { Authorization: `Bearer ${process.env.MCP_PREFLIGHT_LLM_API_KEY || process.env.OPENAI_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: route.model,
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "You are inspecting an MCP server to ensure it is going to function with the MCP broker.",
              "Review the files, run a preflight check on them as they stand, and perform any tasks required in the returned repair plan.",
              "If Python dependencies are required, use the per-server virtualenv described in mcp_server_specs.md.",
              "If there are failures, advise that failures exist and whether they can be resolved.",
              "Read mcp_server_specs.md in the user payload to understand the requirements.",
              "Return only JSON with optional files and launch keys.",
              "Only modify files that are included in the context.",
              "Do not invent dependencies unless required by the observed error.",
              "Prefer minimal, runnable fixes that let MCP initialize and list tools.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              server: {
                command: context.server.command,
                args: context.server.args,
                envKeys: Object.keys(context.server.env || {}),
              },
              preflight: context.preflight,
              dependencyLogs: context.dependencyLogs || [],
              mcp_server_specs_md: mcpServerSpec,
              files,
              expectedJson: {
                summary: "short explanation",
                files: [{ path: "relative/path.py", content: "complete replacement content", summary: "what changed" }],
                launch: { command: context.server.command, args: context.server.args, env: context.server.env, summary: "optional launch change" },
              },
            }),
          },
        ],
      }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || data?.error || `repair model request failed (${response.status})`)
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== "string" || !content.trim()) throw new Error("repair model returned an empty response")
    return {
      route,
      plan: JSON.parse(extractJsonObject(content)) as LlmRepairResponse,
    }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeLaunch(server: McpServerInstall, launch?: LlmRepairResponse["launch"]) {
  if (!launch || typeof launch !== "object") return null
  const command = typeof launch.command === "string" && launch.command.trim() ? launch.command.trim() : server.command
  const args = Array.isArray(launch.args)
    ? launch.args.map((arg) => String(arg ?? "").trim()).filter(Boolean)
    : server.args
  const env = launch.env && typeof launch.env === "object" && !Array.isArray(launch.env)
    ? Object.fromEntries(Object.entries(launch.env).map(([key, value]) => [key.trim(), String(value ?? "").trim()]).filter(([key]) => Boolean(key)))
    : server.env
  if (command === server.command && JSON.stringify(args) === JSON.stringify(server.args) && JSON.stringify(env) === JSON.stringify(server.env)) {
    return null
  }
  return { command, args, env, summary: launch.summary || "Adjusted launch metadata." }
}

export async function repairUploadedMcpServerWithLlm(context: RepairContext): Promise<McpPreflightRepairResult> {
  const files = await readContextFiles(context.projectRoot)
  const { route, plan } = await requestRepairPlan(context, files)
  const changes: McpPreflightRepairChange[] = []

  for (const file of Array.isArray(plan.files) ? plan.files : []) {
    if (typeof file?.path !== "string" || typeof file?.content !== "string") continue
    if (Buffer.byteLength(file.content, "utf8") > MAX_REPAIR_FILE_BYTES) {
      throw new Error(`repair output for ${file.path} is too large`)
    }
    const relative = normalizeRepairPath(file.path)
    if (!files.some((contextFile) => contextFile.path === relative)) {
      throw new Error(`repair model tried to edit a file outside provided context: ${relative}`)
    }
    await writeFile(relativeInside(context.projectRoot, relative), file.content, { mode: 0o600 })
    changes.push({ type: "file", path: relative, summary: file.summary || `Updated ${relative}` })
  }

  const launch = normalizeLaunch(context.server, plan.launch)
  if (launch) {
    changes.push({ type: "launch", summary: launch.summary })
  }

  return {
    attempted: true,
    ok: changes.length > 0,
    provider: "openai-compatible",
    model: route.model,
    baseUrl: route.baseUrl,
    summary: plan.summary || (changes.length > 0 ? "Applied LLM-assisted MCP repair." : "The repair model did not suggest changes."),
    changes,
    updatedServer: launch ? {
      command: launch.command,
      args: launch.args,
      env: launch.env,
    } : undefined,
  }
}
