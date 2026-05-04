import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { HOST_PATH, OPENCLAW_BIN, OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { getDefaultOpenClawInstance, getOpenClawDashboardPortForSandbox, resolveOpenClawInstance } from "./openclawInstances"

const execFileAsync = promisify(execFile)
const OPENSHELL_GATEWAY = process.env.OPENSHELL_GATEWAY || "openshell"
const OPENSHELL_NAMESPACE = "agent-sandbox-system"
const SANDBOX_DASHBOARD_REMOTE_PORT = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT || "18789", 10)

export type HostTelemetry = {
  cpu: number
  memory: number
  disk: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
  timestamp: string
  source: "macos-host"
}

type SandboxInspection = {
  name: string
  id: string | null
  namespace: string | null
  phase: string | null
  rawPhase: string | null
  sshHostAlias: string
  sshConfig: string
  rawDetails: string
}

export type DashboardProbe = {
  reachable: boolean
  status: number | null
  statusText: string
  listenerPresent: boolean
  listenerSummary: string | null
  bootstrapUrl: string | null
  bootstrapTokenPresent: boolean
  bootstrapSource: 'openclaw-cli' | 'static-dashboard-url' | 'unavailable'
  bootstrapAuthority: 'tokenized-cli' | 'static-fallback' | 'none'
}

export async function execOpenShell(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY,
      NO_COLOR: "1",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "0",
    }),
  })
  return { stdout, stderr }
}

function buildOpenClawEnv() {
  const pathEntries = [
    HOST_PATH,
  ].filter(Boolean)

  return {
    ...process.env,
    PATH: pathEntries.join(":"),
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  }
}

async function execOpenClaw(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENCLAW_BIN, args, {
    env: buildOpenClawEnv(),
  })
  return { stdout, stderr }
}

async function execBash(command: string) {
  const { stdout } = await execFileAsync("/bin/bash", ["-lc", command])
  return stdout.trim()
}

function clampPercentage(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "")
}

function parseField(output: string, label: string) {
  const normalizedLabel = label.toLowerCase()
  const line = output
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trim())
    .find((entry) => entry.toLowerCase().startsWith(`${normalizedLabel}:`))

  return line ? line.slice(label.length + 1).trim() : null
}

function parseSshHostAlias(sshConfig: string, fallbackName: string) {
  const hostLine = sshConfig
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith("host "))

  const alias = hostLine
    ?.split(/\s+/)
    .slice(1)
    .find((entry) => entry !== "*")

  return alias || `openshell-${fallbackName}`
}

function parseOpenShellSandboxNames(output: string) {
  return output
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trim())
    .filter((entry) => entry && !/^name\s+/i.test(entry) && !/^[-=]+$/.test(entry))
    .map((entry) => entry.split(/\s{2,}/)[0]?.trim())
    .filter((entry): entry is string => Boolean(entry))
}

export async function resolveSandboxRef(ref: string) {
  const requested = ref.trim()

  try {
    const { stdout } = await execOpenShell(["sandbox", "get", requested])
    return {
      requested,
      name: parseField(stdout, "Name") ?? requested,
      id: parseField(stdout, "Id") ?? requested,
      details: stdout.trim(),
      resolvedBy: "direct" as const,
    }
  } catch (directError) {
    const { stdout: sandboxListStdout } = await execOpenShell(["sandbox", "list"])
    const names = parseOpenShellSandboxNames(sandboxListStdout)

    for (const name of names) {
      try {
        const { stdout } = await execOpenShell(["sandbox", "get", name])
        const sandboxId = parseField(stdout, "Id")
        const sandboxName = parseField(stdout, "Name") ?? name

        if (requested === sandboxId || requested === sandboxName) {
          return {
            requested,
            name: sandboxName,
            id: sandboxId ?? sandboxName,
            details: stdout.trim(),
            resolvedBy: requested === sandboxName ? ("list-name" as const) : ("list-id" as const),
          }
        }
      } catch {
        // Ignore individual sandbox lookup failures while resolving a ref.
      }
    }

    throw directError
  }
}

export function normalizeSandboxPhase(phase: string | null) {
  const value = (phase ?? "Unknown").toLowerCase()

  switch (value) {
    case "ready":
      return "Running"
    case "provisioning":
      return "Pending"
    case "deleting":
      return "Stopping"
    case "error":
      return "Error"
    default:
      return phase ?? "Unknown"
  }
}

async function readCpuUsage() {
  const output = await execBash("top -l 1 -n 0 | grep CPU")
  const match = output.match(/([\d.]+)% idle/)
  const idle = match ? Number.parseFloat(match[1]) : 0
  return clampPercentage(100 - idle)
}

async function readMemoryUsage() {
  const output = await execBash("vm_stat")
  const pageSize = Number.parseInt(output.match(/page size of (\d+) bytes/i)?.[1] ?? "4096", 10)
  const valueFor = (label: string) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = output.match(new RegExp(`${escaped}:\\s+(\\d+)\\.?`, "i"))
    return Number.parseInt(match?.[1] ?? "0", 10)
  }

  const active = valueFor("Pages active")
  const wired = valueFor("Pages wired down")
  const compressed = valueFor("Pages occupied by compressor")
  const speculative = valueFor("Pages speculative")
  const inactive = valueFor("Pages inactive")
  const free = valueFor("Pages free")
  const totalPages = active + wired + compressed + speculative + inactive + free
  const usedPages = active + wired + compressed + speculative

  if (totalPages === 0) {
    return 0
  }

  return clampPercentage((usedPages * pageSize * 100) / (totalPages * pageSize))
}

async function readDiskUsage() {
  const output = await execBash("df -k / | tail -1")
  const columns = output.split(/\s+/)
  const usedPercent = columns[4]?.replace("%", "") ?? "0"
  return clampPercentage(Number.parseFloat(usedPercent))
}

async function inspectListeningPort(port: number) {
  const summary = await execBash(`lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`)

  return {
    listenerPresent: summary.length > 0,
    listenerSummary: summary || null,
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForListeningPort(port: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let latest = await inspectListeningPort(port)

  while (!latest.listenerPresent && Date.now() < deadline) {
    await sleep(250)
    latest = await inspectListeningPort(port)
  }

  return latest
}

function normalizeDashboardBootstrapUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/https?:\/\/\S+/)
  return match ? match[0] : null
}

function hasDashboardToken(value: string | null) {
  if (!value) return false
  try {
    const parsed = new URL(value)
    return parsed.hash.includes('token=') || parsed.searchParams.has('token')
  } catch {
    return /[#?&]token=/.test(value)
  }
}

function rewriteDashboardBootstrapOrigin(bootstrapUrl: string, dashboardUrl: string) {
  const bootstrap = new URL(bootstrapUrl)
  const dashboard = new URL(dashboardUrl)
  bootstrap.protocol = dashboard.protocol
  bootstrap.host = dashboard.host
  return bootstrap.toString()
}

function normalizeDashboardToken(value: string | null | undefined) {
  const token = value?.trim() || ''
  if (!token || /\s/.test(token)) return null
  return token
}

function withDashboardToken(bootstrapUrl: string, token: string | null) {
  if (!token || hasDashboardToken(bootstrapUrl)) return bootstrapUrl
  try {
    const parsed = new URL(bootstrapUrl)
    const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash)
    hashParams.set('token', token)
    parsed.hash = hashParams.toString()
    return parsed.toString()
  } catch {
    const separator = bootstrapUrl.includes('#') ? '&' : '#'
    return `${bootstrapUrl}${separator}token=${encodeURIComponent(token)}`
  }
}

async function readSandboxOpenClawDashboardToken(sandboxName: string) {
  const script = [
    'const fs=require("fs")',
    'const cfg=JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json","utf8"))',
    'const token=cfg?.gateway?.auth?.token||cfg?.gateway?.token||""',
    'if(token) process.stdout.write(String(token))',
  ].join(';')
  const { stdout } = await execSandboxSsh(sandboxName, `node -e '${script}'`, 5000)
  return normalizeDashboardToken(stdout)
}

export async function resolveOpenClawDashboardBootstrap(instanceId?: string | null) {
  const instance = resolveOpenClawInstance(instanceId)
  const defaultInstance = getDefaultOpenClawInstance()
  const canMintBootstrapFromCli = instance.id === defaultInstance.id
  const sandboxInstance = resolveSandboxInstanceId(instance.id)

  if (sandboxInstance) {
    try {
      const { stdout, stderr } = await execSandboxSsh(sandboxInstance.sandboxId, 'openclaw dashboard --no-open', 15000)
      const combined = `${stdout}\n${stderr}`
      const rawBootstrapUrl = normalizeDashboardBootstrapUrl(combined)
      const bootstrapUrl = rawBootstrapUrl
        ? rewriteDashboardBootstrapOrigin(rawBootstrapUrl, instance.dashboardUrl)
        : null
      let tokenizedBootstrapUrl = bootstrapUrl
      let bootstrapTokenPresent = hasDashboardToken(tokenizedBootstrapUrl)

      if (tokenizedBootstrapUrl && !bootstrapTokenPresent) {
        await execSandboxSsh(sandboxInstance.sandboxId, 'openclaw dashboard', 15000).catch(() => null)
        const token = await readSandboxOpenClawDashboardToken(sandboxInstance.sandboxId).catch(() => null)
        tokenizedBootstrapUrl = withDashboardToken(tokenizedBootstrapUrl, token)
        bootstrapTokenPresent = hasDashboardToken(tokenizedBootstrapUrl)
      }

      if (tokenizedBootstrapUrl) {
        return {
          bootstrapUrl: tokenizedBootstrapUrl,
          bootstrapTokenPresent,
          bootstrapSource: 'openclaw-cli' as const,
          bootstrapAuthority: bootstrapTokenPresent ? ('tokenized-cli' as const) : ('static-fallback' as const),
        }
      }
    } catch {
      // Fall through to configured instance URL when sandbox CLI minting is unavailable.
    }
  }

  if (canMintBootstrapFromCli) {
    try {
      const { stdout, stderr } = await execOpenClaw(['dashboard', '--no-open'])
      const combined = `${stdout}\n${stderr}`
      const bootstrapUrl = normalizeDashboardBootstrapUrl(combined)
      const bootstrapTokenPresent = hasDashboardToken(bootstrapUrl)

      if (bootstrapUrl) {
        return {
          bootstrapUrl,
          bootstrapTokenPresent,
          bootstrapSource: 'openclaw-cli' as const,
          bootstrapAuthority: bootstrapTokenPresent ? ('tokenized-cli' as const) : ('static-fallback' as const),
        }
      }
    } catch {
      // Fall through to configured instance URL when CLI minting is unavailable.
    }
  }

  const bootstrapTokenPresent = hasDashboardToken(instance.dashboardUrl)
  return {
    bootstrapUrl: instance.dashboardUrl,
    bootstrapTokenPresent,
    bootstrapSource: instance.dashboardUrl ? ('static-dashboard-url' as const) : ('unavailable' as const),
    bootstrapAuthority: instance.dashboardUrl
      ? (bootstrapTokenPresent ? ('tokenized-cli' as const) : ('static-fallback' as const))
      : ('none' as const),
  }
}

async function ensureOpenClawDashboardListener(instanceId: string, port: number) {
  const instance = resolveOpenClawInstance(instanceId)
  const defaultInstance = getDefaultOpenClawInstance()
  const sandboxInstance = resolveSandboxInstanceId(instance.id)
  if (sandboxInstance) return ensureSandboxOpenClawDashboardTunnel(sandboxInstance.sandboxId)
  if (instance.id !== defaultInstance.id) return inspectListeningPort(port)

  const initial = await inspectListeningPort(port)
  if (initial.listenerPresent) return initial

  const child = spawn(OPENCLAW_BIN, ['gateway', 'run', '--allow-unconfigured', '--bind', 'loopback', '--port', String(port)], {
    detached: true,
    env: buildOpenClawEnv(),
    stdio: 'ignore',
  })
  child.unref()

  return waitForListeningPort(port)
}

function resolveSandboxInstanceId(instanceId: string) {
  const match = instanceId.match(/^sandbox-(\d+)-(.+)$/)
  if (!match) return null
  const port = Number.parseInt(match[1], 10)
  const sandboxId = match[2]
  if (!Number.isFinite(port) || !sandboxId) return null
  return { port, sandboxId }
}

function buildSandboxSshArgs(sandboxName: string, extraArgs: string[]) {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", `ProxyCommand=${OPENSHELL_BIN} ssh-proxy --gateway-name nemoclaw --name ${sandboxName}`,
    `sandbox@openshell-${sandboxName}`,
    ...extraArgs,
  ]
}

async function execSandboxSsh(sandboxName: string, command: string, timeoutMs = 10000) {
  return execFileAsync("ssh", buildSandboxSshArgs(sandboxName, [command]), {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: buildOpenClawEnv(),
  })
}

async function ensureRemoteSandboxOpenClawDashboard(sandboxName: string) {
  const command = [
    `curl -fsS --max-time 2 http://127.0.0.1:${SANDBOX_DASHBOARD_REMOTE_PORT}/ >/dev/null 2>&1`,
    "||",
    `(nohup /usr/local/bin/openclaw gateway run --allow-unconfigured --bind loopback --port ${SANDBOX_DASHBOARD_REMOTE_PORT} >/tmp/gateway.log 2>&1 &)`
  ].join(" ")

  await execSandboxSsh(sandboxName, command).catch(() => null)

  for (let attempt = 0; attempt < 16; attempt += 1) {
    try {
      await execSandboxSsh(sandboxName, `curl -fsS --max-time 2 http://127.0.0.1:${SANDBOX_DASHBOARD_REMOTE_PORT}/ >/dev/null`, 5000)
      return true
    } catch {
      await sleep(500)
    }
  }

  return false
}

async function ensureSandboxOpenClawDashboardTunnel(sandboxName: string) {
  const port = getOpenClawDashboardPortForSandbox(sandboxName)
  if (!port) return inspectListeningPort(SANDBOX_DASHBOARD_REMOTE_PORT)

  const initial = await inspectListeningPort(port)
  if (initial.listenerPresent) return initial

  await ensureRemoteSandboxOpenClawDashboard(sandboxName)

  const child = spawn("ssh", buildSandboxSshArgs(sandboxName, [
    "-N",
    "-L", `127.0.0.1:${port}:127.0.0.1:${SANDBOX_DASHBOARD_REMOTE_PORT}`,
  ]), {
    detached: true,
    env: buildOpenClawEnv(),
    stdio: "ignore",
  })
  child.unref()

  return waitForListeningPort(port, 8000)
}

export async function probeOpenClawDashboard(instanceId?: string | null): Promise<DashboardProbe> {
  const instance = resolveOpenClawInstance(instanceId)
  const target = new URL(instance.dashboardUrl)
  const port = Number.parseInt(target.port || (target.protocol === 'https:' ? '443' : '80'), 10)
  const listener = await ensureOpenClawDashboardListener(instance.id, port)
  const bootstrap = await resolveOpenClawDashboardBootstrap(instance.id)

  try {
    const response = await fetch(instance.dashboardUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    })

    return {
      reachable: response.ok,
      status: response.status,
      statusText: response.statusText,
      listenerPresent: listener.listenerPresent,
      listenerSummary: listener.listenerSummary,
      bootstrapUrl: bootstrap.bootstrapUrl,
      bootstrapTokenPresent: bootstrap.bootstrapTokenPresent,
      bootstrapSource: bootstrap.bootstrapSource,
      bootstrapAuthority: bootstrap.bootstrapAuthority,
    }
  } catch (error) {
    return {
      reachable: false,
      status: null,
      statusText: error instanceof Error ? error.message : 'Dashboard probe failed',
      listenerPresent: listener.listenerPresent,
      listenerSummary: listener.listenerSummary,
      bootstrapUrl: bootstrap.bootstrapUrl,
      bootstrapTokenPresent: bootstrap.bootstrapTokenPresent,
      bootstrapSource: bootstrap.bootstrapSource,
      bootstrapAuthority: bootstrap.bootstrapAuthority,
    }
  }
}

export async function readHostTelemetry(): Promise<HostTelemetry> {
  const [cpu, memory, disk] = await Promise.all([readCpuUsage(), readMemoryUsage(), readDiskUsage()])

  return {
    cpu,
    memory,
    disk,
    timestamp: new Date().toISOString(),
    source: "macos-host",
  }
}

export async function inspectSandbox(ref: string): Promise<SandboxInspection> {
  const resolved = await resolveSandboxRef(ref)
  const [{ stdout: detailsStdout }, { stdout: sshStdout }] = await Promise.all([
    Promise.resolve({ stdout: resolved.details }),
    execOpenShell(["sandbox", "ssh-config", resolved.name]),
  ])

  const sshConfig = sshStdout.trim()

  const rawPhase = parseField(detailsStdout, "Phase")

  return {
    name: parseField(detailsStdout, "Name") ?? resolved.name,
    id: parseField(detailsStdout, "Id") ?? resolved.id,
    namespace: parseField(detailsStdout, "Namespace"),
    phase: normalizeSandboxPhase(rawPhase),
    rawPhase,
    sshHostAlias: parseSshHostAlias(sshConfig, resolved.name),
    sshConfig,
    rawDetails: detailsStdout.trim(),
  }
}

export async function probeSandboxShell(name: string) {
  return inspectSandbox(name)
}

export function isOpenShellTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "")
  const normalized = message.toLowerCase()

  return (
    normalized.includes("transport error") ||
    normalized.includes("connection refused") ||
    normalized.includes("tcp connect error")
  )
}

export function getOpenClawDashboardUrl(instanceId?: string | null) {
  return resolveOpenClawInstance(instanceId).dashboardUrl
}

export function getDefaultOpenClawDashboardInstanceId() {
  return getDefaultOpenClawInstance().id
}

export { OPENSHELL_BIN, OPENSHELL_GATEWAY, OPENSHELL_NAMESPACE }
export { OPENCLAW_BIN }
