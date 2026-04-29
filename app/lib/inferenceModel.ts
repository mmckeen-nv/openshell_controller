import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

const execFileAsync = promisify(execFile)

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function readField(output: string, label: string) {
  const match = output.match(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "im"))
  return match ? match[1].trim() : ""
}

function parseRouteModel(output: string, label: "Gateway inference" | "System inference") {
  const otherLabel = label === "Gateway inference" ? "System inference" : "Gateway inference"
  const pattern = new RegExp(`${label}:\\s*([\\s\\S]*?)(?:\\n\\s*${otherLabel}:|$)`, "i")
  const section = output.match(pattern)?.[1] ?? ""
  if (!section || /Not configured/i.test(section)) return ""
  return readField(section, "Model")
}

async function readOpenShellInferenceModel() {
  const { stdout } = await execFileAsync(OPENSHELL_BIN, ["inference", "get"], {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
    }),
    timeout: 30000,
    maxBuffer: 5 * 1024 * 1024,
  })
  const output = stripAnsi(String(stdout).trim())
  return parseRouteModel(output, "Gateway inference") || parseRouteModel(output, "System inference")
}

export async function resolvePrimaryInferenceModel(explicitModel?: string | null) {
  if (explicitModel?.trim()) return explicitModel.trim()
  if (process.env.MCP_PREFLIGHT_LLM_MODEL?.trim()) return process.env.MCP_PREFLIGHT_LLM_MODEL.trim()
  try {
    const configured = await readOpenShellInferenceModel()
    if (configured) return configured
  } catch {
    // Callers surface endpoint failures; model resolution falls through to explicit env compatibility.
  }
  return process.env.OPENAI_MODEL?.trim() || process.env.VLLM_MODEL?.trim() || ""
}

export function resolveOpenAiCompatibleBaseUrl() {
  return (process.env.MCP_PREFLIGHT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.VLLM_BASE_URL || "http://localhost:8000/v1").replace(/\/+$/, "")
}
