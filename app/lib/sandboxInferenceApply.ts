import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { HOST_PATH, OPENSHELL_BIN } from "./hostCommands"
import { getSandboxInferenceConfig, type SandboxInferenceRoute } from "./sandboxInferenceStore"

const execFileAsync = promisify(execFile)
const DOCKER_BIN = process.env.DOCKER_BIN || "docker"
const OPENSHELL_CLUSTER_CONTAINER = process.env.OPENSHELL_CLUSTER_CONTAINER || "openshell-cluster-nemoclaw"

function modelEntry(route: SandboxInferenceRoute, openClawModelRef: string, compat: Record<string, unknown> | null) {
  return {
    ...(compat ? { compat } : {}),
    id: route.model,
    name: openClawModelRef,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
    maxTokens: 4096,
  }
}

function resolveOpenClawRoute(route: SandboxInferenceRoute) {
  switch (route.provider) {
    case "openai-api":
      return {
        providerKey: "openai",
        modelRef: `openai/${route.model}`,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: null,
      }
    case "anthropic-prod":
    case "compatible-anthropic-endpoint":
      return {
        providerKey: "anthropic",
        modelRef: `anthropic/${route.model}`,
        baseUrl: "https://inference.local",
        api: "anthropic-messages",
        compat: null,
      }
    case "bedrock":
    case "compatible-endpoint":
    case "gemini-api":
      return {
        providerKey: "inference",
        modelRef: `inference/${route.model}`,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: { supportsStore: false },
      }
    case "nvidia-prod":
    case "nvidia-nim":
    case "ollama-local":
    case "vllm-local":
    default:
      return {
        providerKey: "inference",
        modelRef: `inference/${route.model}`,
        baseUrl: "https://inference.local/v1",
        api: "openai-completions",
        compat: null,
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
    providers[resolved.providerKey].models.push(modelEntry(route, resolved.modelRef, resolved.compat))
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
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

async function runDockerKubectl(args: string[], input?: string) {
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(DOCKER_BIN, ["exec", ...(input ? ["-i"] : []), OPENSHELL_CLUSTER_CONTAINER, "kubectl", ...args], {
      env: { ...process.env, PATH: HOST_PATH },
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
  const result = await runDockerKubectl(["exec", "-n", "openshell", sandboxName, "--", "cat", "/sandbox/.openclaw/openclaw.json"])
  if (result.code !== 0) throw new Error(result.stderr || "Failed to read OpenClaw config")
  return JSON.parse(result.stdout)
}

async function writeOpenClawConfig(sandboxName: string, config: any) {
  const payload = `${JSON.stringify(config, null, 2)}\n`
  const script = [
    "cat > /sandbox/.openclaw/openclaw.json",
    "chmod 444 /sandbox/.openclaw/openclaw.json",
    "chown root:root /sandbox/.openclaw/openclaw.json",
    "sha256sum /sandbox/.openclaw/openclaw.json > /sandbox/.openclaw/.config-hash",
    "chmod 444 /sandbox/.openclaw/.config-hash",
    "chown root:root /sandbox/.openclaw/.config-hash",
  ].join(" && ")
  const result = await runDockerKubectl(["exec", "-i", "-n", "openshell", sandboxName, "--", "sh", "-lc", script], payload)
  if (result.code !== 0) throw new Error(result.stderr || "Failed to write OpenClaw config")
  return result
}

async function restartOpenClawGatewayIfRunning(sandboxName: string) {
  const script = "for p in /proc/[0-9]*; do cmd=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null || true); case \"$cmd\" in *'openclaw gateway'*) kill \"${p##*/}\" 2>/dev/null || true;; esac; done"
  return await runDockerKubectl(["exec", "-n", "openshell", sandboxName, "--", "sh", "-lc", script])
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
