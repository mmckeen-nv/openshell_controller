import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { HOST_PATH, OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { resolveSandboxRef } from "./openshellHost"

const execFileAsync = promisify(execFile)

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "host.docker.internal", "host.openshell.internal"])
const FALLBACK_SANDBOX_PROXY_ORIGIN = "http://10.200.0.1:3128"

function shouldUseProxyWrappedBrokerUrl() {
  return /^(1|true|yes|on)$/i.test(process.env.OPENSHELL_CONTROL_MCP_BROKER_PROXY_URL || "")
}

async function discoverOpenShellDockerGateway() {
  const container = process.env.OPEN_SHELL_CONTAINER || "openshell-cluster-nemoclaw"
  const { stdout } = await execFileAsync("docker", ["inspect", container], {
    env: { ...process.env, PATH: HOST_PATH },
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  })
  const [inspect] = JSON.parse(String(stdout)) as Array<{
    NetworkSettings?: {
      Networks?: Record<string, { Gateway?: string }>
    }
  }>
  const networks = inspect?.NetworkSettings?.Networks || {}
  return Object.values(networks).map((network) => network.Gateway).find(Boolean) || null
}

function normalizeProxyOrigin(value: string) {
  try {
    const proxy = new URL(value)
    if (proxy.protocol !== "http:" && proxy.protocol !== "https:") return null
    return proxy.toString().replace(/\/+$/, "")
  } catch {
    return null
  }
}

async function runOpenShell(args: string[]) {
  const { stdout } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      TERM: "dumb",
    }),
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  })
  return String(stdout)
}

async function discoverSandboxProxyOrigin(sandboxId: string, sandboxName?: string | null) {
  const resolvedName = sandboxName || (await resolveSandboxRef(sandboxId)).name
  const script = "printf '%s\\n' \"${HTTP_PROXY:-${http_proxy:-${HTTPS_PROXY:-${https_proxy:-}}}}\""
  const output = await runOpenShell(["sandbox", "exec", "-n", resolvedName, "--", "sh", "-lc", script])
  return normalizeProxyOrigin(output.trim())
}

export async function brokerBaseUrlForSandbox(
  request: Request,
  sandbox?: { id: string, name?: string | null },
) {
  if (process.env.OPENSHELL_CONTROL_MCP_BROKER_URL) return process.env.OPENSHELL_CONTROL_MCP_BROKER_URL

  const origin = new URL(request.url).origin
  const publicOrigin = new URL(origin)
  if (LOCAL_HOSTNAMES.has(publicOrigin.hostname)) {
    const gateway = await discoverOpenShellDockerGateway().catch(() => null)
    publicOrigin.hostname = gateway || "host.docker.internal"
  }

  const hostBrokerUrl = `${publicOrigin.toString().replace(/\/+$/, "")}/api/mcp/broker`
  if (!shouldUseProxyWrappedBrokerUrl()) return hostBrokerUrl

  const proxyOrigin = sandbox
    ? await discoverSandboxProxyOrigin(sandbox.id, sandbox.name).catch(() => null)
    : null
  if (proxyOrigin) return `${proxyOrigin}/${hostBrokerUrl}`
  if (LOCAL_HOSTNAMES.has(new URL(origin).hostname)) return `${FALLBACK_SANDBOX_PROXY_ORIGIN}/${hostBrokerUrl}`
  return hostBrokerUrl
}
