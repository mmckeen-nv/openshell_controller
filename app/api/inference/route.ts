import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { HOST_PATH, OPENSHELL_BIN } from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)

const PROVIDER_TYPES = new Set(["openai", "anthropic", "nvidia", "generic", "claude", "opencode", "codex", "copilot", "gitlab", "github", "outlook"])

type InferenceRoute = {
  configured: boolean
  provider: string | null
  model: string | null
  version: string | null
  timeout: string | null
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

async function runOpenShell(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: {
      ...process.env,
      PATH: HOST_PATH,
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      NO_COLOR: "1",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "0",
    },
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return { stdout: stripAnsi(String(stdout).trim()), stderr: stripAnsi(String(stderr).trim()) }
}

function readField(output: string, label: string) {
  const match = output.match(new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "im"))
  return match ? match[1].trim() : null
}

function parseRoute(output: string, label: "Gateway inference" | "System inference"): InferenceRoute {
  const otherLabel = label === "Gateway inference" ? "System inference" : "Gateway inference"
  const pattern = new RegExp(`${label}:\\s*([\\s\\S]*?)(?:\\n\\s*${otherLabel}:|$)`, "i")
  const section = output.match(pattern)?.[1] ?? ""
  if (!section || /Not configured/i.test(section)) {
    return { configured: false, provider: null, model: null, version: null, timeout: null }
  }
  return {
    configured: true,
    provider: readField(section, "Provider"),
    model: readField(section, "Model"),
    version: readField(section, "Version"),
    timeout: readField(section, "Timeout"),
  }
}

function parseProvider(output: string) {
  return {
    id: readField(output, "Id"),
    name: readField(output, "Name"),
    type: readField(output, "Type"),
    credentialKeys: (readField(output, "Credential keys") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    configKeys: (readField(output, "Config keys") || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  }
}

async function readProviders() {
  const { stdout } = await runOpenShell(["provider", "list", "--names"])
  const names = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const providers = await Promise.all(names.map(async (name) => {
    try {
      const details = await runOpenShell(["provider", "get", name])
      return parseProvider(details.stdout)
    } catch {
      return { id: null, name, type: null, credentialKeys: [], configKeys: [] }
    }
  }))
  return providers
}

function validateName(name: unknown) {
  if (typeof name !== "string" || !name.trim()) throw new Error("provider name is required")
  const value = name.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(value)) {
    throw new Error("provider name must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens")
  }
  return value
}

function validateProviderType(type: unknown) {
  const value = typeof type === "string" && type.trim() ? type.trim() : "openai"
  if (!PROVIDER_TYPES.has(value)) throw new Error(`unsupported provider type: ${value}`)
  return value
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function providerCredentialArg(credentialKey: string, apiKey: string) {
  return apiKey ? `${credentialKey}=${apiKey}` : credentialKey
}

export async function GET() {
  try {
    const [inference, providers] = await Promise.all([
      runOpenShell(["inference", "get"]),
      readProviders(),
    ])
    return NextResponse.json({
      ok: true,
      gateway: parseRoute(inference.stdout, "Gateway inference"),
      system: parseRoute(inference.stdout, "System inference"),
      providers,
      raw: inference.stdout,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read inference configuration"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const name = validateName(body?.name)
    const type = validateProviderType(body?.type)
    const model = optionalString(body?.model)
    const baseUrl = optionalString(body?.baseUrl)
    const apiKey = optionalString(body?.apiKey)
    const credentialKey = optionalString(body?.credentialKey) || "OPENAI_API_KEY"
    const makeActive = body?.makeActive !== false
    const system = body?.route === "system" || body?.system === true
    const noVerify = body?.noVerify !== false
    const timeout = Number(body?.timeout ?? 0)

    if (makeActive && !model) throw new Error("model is required when making the endpoint active")
    if (!/^[A-Z_][A-Z0-9_]*$/.test(credentialKey)) throw new Error("credential key must look like an environment variable name")
    if (baseUrl) new URL(baseUrl)

    const existingNames = (await readProviders()).map((provider) => provider.name).filter(Boolean)
    const providerArgs = existingNames.includes(name)
      ? ["provider", "update", name]
      : ["provider", "create", "--name", name, "--type", type]

    if (!existingNames.includes(name) && !apiKey) providerArgs.push("--from-existing")
    if (apiKey) providerArgs.push("--credential", providerCredentialArg(credentialKey, apiKey))
    if (baseUrl) providerArgs.push("--config", `OPENAI_BASE_URL=${baseUrl}`)

    const providerResult = await runOpenShell(providerArgs)
    let inferenceResult = null
    if (makeActive) {
      const routeArgs = ["inference", "set", "--provider", name, "--model", model]
      if (system) routeArgs.push("--system")
      if (noVerify) routeArgs.push("--no-verify")
      if (Number.isFinite(timeout) && timeout >= 0) routeArgs.push("--timeout", String(timeout))
      inferenceResult = await runOpenShell(routeArgs)
    }

    const refreshed = await runOpenShell(["inference", "get"])
    return NextResponse.json({
      ok: true,
      provider: name,
      active: makeActive,
      gateway: parseRoute(refreshed.stdout, "Gateway inference"),
      system: parseRoute(refreshed.stdout, "System inference"),
      stdout: [providerResult.stdout, inferenceResult?.stdout].filter(Boolean).join("\n\n"),
      stderr: [providerResult.stderr, inferenceResult?.stderr].filter(Boolean).join("\n\n"),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save inference endpoint"
    return NextResponse.json({ ok: false, error: message }, { status: /required|unsupported|must|URL/.test(message) ? 400 : 500 })
  }
}
