import { brokerBaseUrlForSandbox } from "./mcpBrokerUrl"
import type { McpServerInstall } from "./mcpServerStore"
import { sandboxCanAccessMcpServer } from "./mcpServerStore"
import { execOpenShell, resolveSandboxRef } from "./openshellHost"
import { revokeSandboxMcpManifest, syncSandboxMcpManifest } from "./sandboxMcpManifest"
import { revokeBrokerNetworkAccess, syncBrokerNetworkAccess } from "./sandboxPermissions"

type SandboxRef = {
  id: string
  name: string
}

export type SandboxMcpAutoSyncResult = {
  sandboxId: string
  sandboxName: string
  action: "sync" | "revoke"
  ok: boolean
  error?: string
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "")
}

function parseOpenShellSandboxNames(output: string) {
  return output
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trim())
    .filter(
      (entry) =>
        entry &&
        !/^name\s+/i.test(entry) &&
        !/^[\s\-=]+$/.test(entry) &&
        !/^no sandboxes found\.?$/i.test(entry),
    )
    .map((entry) => entry.split(/\s{2,}/)[0]?.trim())
    .filter((entry): entry is string => Boolean(entry))
}

async function listLiveSandboxRefs() {
  const { stdout } = await execOpenShell(["sandbox", "list"])
  const names = parseOpenShellSandboxNames(stdout)
  const refs: SandboxRef[] = []

  for (const name of names) {
    try {
      const resolved = await resolveSandboxRef(name)
      refs.push({
        id: resolved.id || resolved.name,
        name: resolved.name,
      })
    } catch {
      refs.push({ id: name, name })
    }
  }

  return refs
}

function sandboxHasMcpAccess(servers: McpServerInstall[], sandbox: SandboxRef) {
  return servers.some((server) => sandboxCanAccessMcpServer(server, sandbox.id, sandbox.name))
}

function changedServerAccessChanged(
  beforeServers: McpServerInstall[],
  afterServers: McpServerInstall[],
  changedServerIds: Set<string>,
  sandbox: SandboxRef,
) {
  for (const serverId of changedServerIds) {
    const before = beforeServers.find((server) => server.id === serverId)
    const after = afterServers.find((server) => server.id === serverId)
    const beforeCanAccess = before ? sandboxCanAccessMcpServer(before, sandbox.id, sandbox.name) : false
    const afterCanAccess = after ? sandboxCanAccessMcpServer(after, sandbox.id, sandbox.name) : false
    if (beforeCanAccess !== afterCanAccess) return true
  }
  return false
}

async function syncOneSandboxMcp(
  request: Request,
  sandbox: SandboxRef,
  action: "sync" | "revoke",
): Promise<SandboxMcpAutoSyncResult> {
  try {
    const brokerUrl = await brokerBaseUrlForSandbox(request, sandbox)
    if (action === "revoke") {
      await revokeSandboxMcpManifest(sandbox)
      await revokeBrokerNetworkAccess(sandbox.id, brokerUrl)
    } else {
      await syncSandboxMcpManifest(sandbox, { brokerBaseUrl: brokerUrl })
      await syncBrokerNetworkAccess(sandbox.id, brokerUrl)
    }

    return {
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      action,
      ok: true,
    }
  } catch (error) {
    return {
      sandboxId: sandbox.id,
      sandboxName: sandbox.name,
      action,
      ok: false,
      error: error instanceof Error ? error.message : "Failed to sync sandbox MCP config",
    }
  }
}

export async function autoSyncSandboxMcpAccess(
  request: Request,
  beforeServers: McpServerInstall[],
  afterServers: McpServerInstall[],
  changedServerIds: string[],
) {
  const changed = new Set(changedServerIds.filter(Boolean))
  if (changed.size === 0) return []

  const sandboxes = await listLiveSandboxRefs().catch(() => [] as SandboxRef[])
  const results: SandboxMcpAutoSyncResult[] = []

  for (const sandbox of sandboxes) {
    const beforeHasAccess = sandboxHasMcpAccess(beforeServers, sandbox)
    const afterHasAccess = sandboxHasMcpAccess(afterServers, sandbox)
    const changedServerTouchedSandbox = changedServerAccessChanged(beforeServers, afterServers, changed, sandbox)
    if (!beforeHasAccess && !afterHasAccess && !changedServerTouchedSandbox) continue

    if (afterHasAccess && (!beforeHasAccess || changedServerTouchedSandbox)) {
      results.push(await syncOneSandboxMcp(request, sandbox, "sync"))
    } else if (beforeHasAccess && !afterHasAccess) {
      results.push(await syncOneSandboxMcp(request, sandbox, "revoke"))
    }
  }

  return results
}
