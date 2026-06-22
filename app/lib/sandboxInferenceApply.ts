import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { getSandboxInferenceConfig, type SandboxInferenceRoute } from "./sandboxInferenceStore"

const execFileAsync = promisify(execFile)

function modelContextWindow(modelId: string) {
  const normalized = modelId.toLowerCase()
  if (normalized.includes("nemotron-3-super") && normalized.includes("120b")) return 262144
  if (normalized.includes("qwen2.5:7b")) return 32768
  if (normalized.includes("qwen3.5:27b")) return 32768
  return 131072
}

function modelMaxTokens(modelId: string) {
  const contextWindow = modelContextWindow(modelId)
  if (contextWindow >= 262144) return 8192
  if (contextWindow <= 32768) return 2048
  return 4096
}

function modelSupportsReasoning(modelId: string) {
  const normalized = modelId.toLowerCase()
  return normalized.includes("nemotron-3-super")
}

function modelEntry(modelId: string, modelName: string, compat: Record<string, unknown> | null) {
  return {
    ...(compat ? { compat } : {}),
    id: modelId,
    name: modelName,
    reasoning: modelSupportsReasoning(modelId),
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: modelContextWindow(modelId),
    maxTokens: modelMaxTokens(modelId),
  }
}

function resolveInferenceModelIdentity(route: SandboxInferenceRoute) {
  const nvidiaModel = route.model.match(/^nvidia\/(.+)$/i)
  if (nvidiaModel) {
    return {
      providerKey: "nvidia",
      modelId: nvidiaModel[1],
      modelName: route.model,
      modelRef: route.model,
    }
  }
  return {
    providerKey: "inference",
    modelId: route.model,
    modelName: route.model,
    modelRef: `inference/${route.model}`,
  }
}

function resolveOpenClawRoute(route: SandboxInferenceRoute) {
  switch (route.provider) {
    case "openai-api":
      return {
        providerKey: "openai",
        modelId: route.model,
        modelName: route.model,
        modelRef: `openai/${route.model}`,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: null,
      }
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      return {
        providerKey: "anthropic",
        modelId: route.model,
        modelName: route.model,
        modelRef: `anthropic/${route.model}`,
        baseUrl: "https://inference.local",
        api: "anthropic-messages",
        compat: null,
      }
    case "bedrock":
    case "compatible-endpoint":
    case "gemini-api": {
      const identity = resolveInferenceModelIdentity(route)
      return {
        ...identity,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: { supportsStore: false },
      }
    }
    case "nvidia-prod":
    case "nvidia-nim":
    case "ollama-local":
    case "vllm-local":
    default: {
      const identity = resolveInferenceModelIdentity(route)
      return {
        ...identity,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: null,
      }
    }
  }
}

function buildOpenClawConfig(current: any, routes: SandboxInferenceRoute[], primary: SandboxInferenceRoute) {
  const providers: Record<string, any> = {}
  let primaryModelRef = primary.model
  const channelDefaults = { ...(current?.channels?.defaults || {}) }
  delete channelDefaults.configWrites

  for (const route of routes.filter((item) => item.enabled)) {
    const resolved = resolveOpenClawRoute(route)
    providers[resolved.providerKey] ||= {
      baseUrl: resolved.baseUrl,
      apiKey: "unused",
      api: resolved.api,
      models: [],
    }
    providers[resolved.providerKey].models.push(modelEntry(resolved.modelId, resolved.modelName, resolved.compat))
    if (route.id === primary.id) primaryModelRef = resolved.modelRef
  }

  return {
    ...current,
    agents: {
      ...(current?.agents || {}),
      defaults: {
        ...(current?.agents?.defaults || {}),
        model: {
          ...(current?.agents?.defaults?.model || {}),
          primary: primaryModelRef,
        },
      },
    },
    models: {
      ...(current?.models || {}),
      mode: "merge",
      providers,
    },
    channels: {
      ...(current?.channels || {}),
      defaults: {
        ...channelDefaults,
      },
    },
  }
}

async function runOpenShell(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
    }),
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

async function runSandboxExec(sandboxName: string, command: string[], input?: string) {
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", ...command], {
      env: hostCommandEnv({ OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw" }),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

async function readCurrentOpenClawConfig(sandboxName: string) {
  const result = await runSandboxExec(sandboxName, ["cat", "/sandbox/.openclaw/openclaw.json"])
  if (result.code !== 0) throw new Error(result.stderr || "Failed to read OpenClaw config")
  return JSON.parse(result.stdout)
}

async function writeOpenClawConfig(sandboxName: string, config: any) {
  const payload = `${JSON.stringify(config, null, 2)}\n`
  const script = [
    "set -e",
    "chmod 644 /sandbox/.openclaw/openclaw.json 2>/dev/null || true",
    "cat > /sandbox/.openclaw/openclaw.json",
    "chmod 444 /sandbox/.openclaw/openclaw.json",
    "chmod 644 /sandbox/.openclaw/.config-hash 2>/dev/null || true",
    "sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash",
    "chmod 444 /sandbox/.openclaw/.config-hash",
  ].join("\n")
  const result = await runSandboxExec(sandboxName, ["sh", "-lc", script], payload)
  if (result.code !== 0) throw new Error(result.stderr || "Failed to write OpenClaw config")
  return result
}

async function restartOpenClawGatewayIfRunning(sandboxName: string) {
  const script = "for p in /proc/[0-9]*; do cmd=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null || true); case \"$cmd\" in *'openclaw gateway'*) kill \"${p##*/}\" 2>/dev/null || true;; esac; done"
  return await runSandboxExec(sandboxName, ["sh", "-lc", script])
}

export async function applySandboxInferenceProfile(sandboxId: string, sandboxName: string) {
  const config = await getSandboxInferenceConfig(sandboxId)
  const enabledRoutes = config.routes.filter((route) => route.enabled)
  if (enabledRoutes.length === 0) throw new Error("No enabled inference routes are configured for this sandbox")
  const primary = enabledRoutes.find((route) => route.id === config.primaryRouteId) || enabledRoutes[0]

  const currentOpenClawConfig = await readCurrentOpenClawConfig(sandboxName)
  const nextOpenClawConfig = buildOpenClawConfig(currentOpenClawConfig, enabledRoutes, primary)
  await writeOpenClawConfig(sandboxName, nextOpenClawConfig)
  await restartOpenClawGatewayIfRunning(sandboxName)

  const routeResult = await runOpenShell(["inference", "set", "--no-verify", "--provider", primary.provider, "--model", primary.model])
  return {
    primaryRoute: primary,
    routesApplied: enabledRoutes.length,
    gatewayRoute: routeResult,
  }
}
