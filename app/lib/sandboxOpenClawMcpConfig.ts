import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

export const OPENSHELL_CONTROL_MCP_SERVER_NAME = "openshell-control"
export const OPENCLAW_CONFIG_PATH = "/sandbox/.openclaw/openclaw.json"
const OPENCLAW_CONFIG_HASH_PATH = "/sandbox/.openclaw/.config-hash"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeBrokerBaseUrl(value: string) {
  return value.replace(/\/+$/, "")
}

function runSandboxExec(sandboxName: string, command: string[], input?: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
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

async function readOpenClawConfig(sandboxName: string) {
  const result = await runSandboxExec(sandboxName, ["cat", OPENCLAW_CONFIG_PATH])
  if (result.code !== 0) {
    if (/no such file or directory/i.test(result.stderr)) return null
    throw new Error(result.stderr || "Failed to read OpenClaw config")
  }
  const parsed = JSON.parse(result.stdout)
  if (!isRecord(parsed)) throw new Error("OpenClaw config must be a JSON object")
  return parsed
}

async function writeOpenClawConfig(sandboxName: string, config: Record<string, unknown>) {
  const payload = `${JSON.stringify(config, null, 2)}\n`
  // chown root:root is best-effort: openshell sandbox exec runs as the
  // sandbox user, which cannot chown to root on the Docker driver.
  const script = [
    `cat > ${OPENCLAW_CONFIG_PATH}`,
    `chmod 444 ${OPENCLAW_CONFIG_PATH}`,
    `chown root:root ${OPENCLAW_CONFIG_PATH} 2>/dev/null || true`,
    `sha256sum ${OPENCLAW_CONFIG_PATH} > ${OPENCLAW_CONFIG_HASH_PATH}`,
    `chmod 444 ${OPENCLAW_CONFIG_HASH_PATH}`,
    `chown root:root ${OPENCLAW_CONFIG_HASH_PATH} 2>/dev/null || true`,
  ].join(" && ")
  const result = await runSandboxExec(sandboxName, ["sh", "-lc", script], payload)
  if (result.code !== 0) throw new Error(result.stderr || "Failed to write OpenClaw MCP config")
}

async function restartOpenClawGatewayIfRunning(sandboxName: string) {
  const script = "for p in /proc/[0-9]*; do cmd=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null || true); case \"$cmd\" in *'openclaw gateway'*) kill \"${p##*/}\" 2>/dev/null || true;; esac; done"
  await runSandboxExec(sandboxName, ["sh", "-lc", script])
}

export function buildOpenClawMcpServerConfig(brokerBaseUrl: string, token: string) {
  return {
    transport: "streamable-http",
    url: `${normalizeBrokerBaseUrl(brokerBaseUrl)}/mcp`,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    connectionTimeoutMs: 45000,
  }
}

export async function syncSandboxOpenClawMcpConfig(
  sandboxName: string,
  brokerBaseUrl: string,
  token: string,
) {
  const current = await readOpenClawConfig(sandboxName)
  if (!current) {
    return {
      path: OPENCLAW_CONFIG_PATH,
      serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
      skipped: true,
      reason: "OpenClaw is not installed in this sandbox; MCP broker is wired only through the sandbox manifest.",
    }
  }
  const mcp = isRecord(current.mcp) ? { ...current.mcp } : {}
  const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {}
  const serverConfig = buildOpenClawMcpServerConfig(brokerBaseUrl, token)

  servers[OPENSHELL_CONTROL_MCP_SERVER_NAME] = serverConfig
  mcp.servers = servers

  await writeOpenClawConfig(sandboxName, {
    ...current,
    mcp,
  })
  await restartOpenClawGatewayIfRunning(sandboxName)

  return {
    path: OPENCLAW_CONFIG_PATH,
    serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
    transport: serverConfig.transport,
    url: serverConfig.url,
  }
}

export async function revokeSandboxOpenClawMcpConfig(sandboxName: string) {
  const current = await readOpenClawConfig(sandboxName)
  if (!current) {
    return {
      path: OPENCLAW_CONFIG_PATH,
      serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
      removed: false,
      skipped: true,
      reason: "OpenClaw is not installed in this sandbox; nothing to revoke from openclaw.json.",
    }
  }
  const mcp = isRecord(current.mcp) ? { ...current.mcp } : {}
  const servers = isRecord(mcp.servers) ? { ...mcp.servers } : {}
  delete servers[OPENSHELL_CONTROL_MCP_SERVER_NAME]

  const nextConfig: Record<string, unknown> = { ...current }
  if (Object.keys(servers).length > 0) {
    mcp.servers = servers
    nextConfig.mcp = mcp
  } else {
    delete mcp.servers
    if (Object.keys(mcp).length > 0) nextConfig.mcp = mcp
    else delete nextConfig.mcp
  }

  await writeOpenClawConfig(sandboxName, nextConfig)
  await restartOpenClawGatewayIfRunning(sandboxName)

  return {
    path: OPENCLAW_CONFIG_PATH,
    serverName: OPENSHELL_CONTROL_MCP_SERVER_NAME,
    removed: true,
  }
}
