import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { restartSandboxGatewayWithNemoClaw } from "./nemoclawCli"
import { writeNativeOpenClawConfigPatch } from "./openClawNativeConfig"
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

function buildOpenClawConfigPatch(routes: SandboxInferenceRoute[], primary: SandboxInferenceRoute) {
  const providers: Record<string, any> = {}
  let primaryModelRef = primary.model

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
    agents: {
      defaults: {
        model: {
          primary: primaryModelRef,
        },
      },
    },
    models: {
      mode: "merge",
      providers,
    },
    channels: {
      defaults: {
        configWrites: null,
      },
    },
  }
}

async function runOpenShell(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || undefined,
    }),
    timeout: 60000,
    maxBuffer: 20 * 1024 * 1024,
  })
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

export async function applySandboxInferenceProfile(sandboxId: string, sandboxName: string) {
  const config = await getSandboxInferenceConfig(sandboxId)
  const enabledRoutes = config.routes.filter((route) => route.enabled)
  if (enabledRoutes.length === 0) throw new Error("No enabled inference routes are configured for this sandbox")
  const primary = enabledRoutes.find((route) => route.id === config.primaryRouteId) || enabledRoutes[0]

  const openClawPatch = buildOpenClawConfigPatch(enabledRoutes, primary)
  await writeNativeOpenClawConfigPatch(
    sandboxName,
    openClawPatch,
    "Failed to apply native OpenClaw inference config",
  )
  const routeResult = await runOpenShell(["inference", "set", "--no-verify", "--provider", primary.provider, "--model", primary.model])
  const restartResult = await restartSandboxGatewayWithNemoClaw(sandboxName)
  if (!restartResult.ok) {
    throw new Error(
      restartResult.stderr || restartResult.error ||
      "NemoClaw could not verify the native agent gateway restart after applying inference config",
    )
  }
  return {
    primaryRoute: primary,
    routesApplied: enabledRoutes.length,
    gatewayRoute: routeResult,
    gatewayRestart: "nemoclaw-native-gateway",
  }
}
