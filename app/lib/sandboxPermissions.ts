import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"
import { resolveSandboxRef } from "./openshellHost"

const execFileAsync = promisify(execFile)

export type SandboxNetworkRule = {
  chunkId: string
  status: string
  rule: string
  binary: string
  confidence: string
  rationale: string
  endpoints: string[]
  binaries: string[]
}

type BrokerNetworkAction = {
  action: "approve" | "reject"
  chunkId: string
  endpoint: string
  status: string
}

function runOpenShell(args: string[], timeout = 60000) {
  return execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      TERM: "dumb",
    }),
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseNetworkRules(output: string): SandboxNetworkRule[] {
  const clean = stripAnsi(output)
  const chunks = clean.split(/\n\s*Chunk:\s+/).slice(1)

  return chunks
    .map((chunk) => {
      const lines = chunk.split(/\r?\n/)
      const chunkId = lines.shift()?.trim() || ""
      const fields = new Map<string, string>()

      for (const line of lines) {
        const match = line.match(/^\s*([^:]+):\s*(.*)$/)
        if (!match) continue
        fields.set(match[1].trim().toLowerCase(), match[2].trim())
      }

      return {
        chunkId,
        status: fields.get("status") || "unknown",
        rule: fields.get("rule") || "",
        binary: fields.get("binary") || "",
        confidence: fields.get("confidence") || "",
        rationale: fields.get("rationale") || "",
        endpoints: parseList(fields.get("endpoints") || ""),
        binaries: parseList(fields.get("binaries") || ""),
      }
    })
    .filter((rule) => rule.chunkId)
}

function hostPortForUrl(parsed: URL) {
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
  return `${parsed.hostname}:${port}`
}

function addEndpointCandidate(candidates: Set<string>, parsed: URL) {
  const hostPort = hostPortForUrl(parsed)
  candidates.add(hostPort)
  if (parsed.hostname === "host.docker.internal") {
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
    candidates.add(`0.0.0.0:${port}`)
  }
}

function extractProxiedTargetUrl(brokerBaseUrl: string) {
  try {
    const parsed = new URL(brokerBaseUrl)
    const rawPath = parsed.pathname.replace(/^\/+/, "")
    const decodedPath = decodeURIComponent(rawPath)
    if (!/^https?:\/\//i.test(decodedPath)) return null
    return new URL(decodedPath)
  } catch {
    return null
  }
}

function brokerEndpointCandidates(brokerBaseUrl: string) {
  const parsed = new URL(brokerBaseUrl)
  const candidates = new Set<string>()
  addEndpointCandidate(candidates, parsed)

  const proxiedTarget = extractProxiedTargetUrl(brokerBaseUrl)
  if (proxiedTarget) addEndpointCandidate(candidates, proxiedTarget)

  return candidates
}

function ruleMatchesEndpoints(rule: SandboxNetworkRule, candidates: Set<string>) {
  return rule.endpoints.some((endpoint) => candidates.has(endpoint))
    || Array.from(candidates).some((endpoint) => rule.rule.includes(endpoint.replace(/[^a-zA-Z0-9]/g, "_")))
    || Array.from(candidates).some((endpoint) => rule.rationale.includes(endpoint))
}

async function listRulesForStatus(sandboxName: string, status: "pending" | "approved" | "rejected") {
  const { stdout } = await runOpenShell(["rule", "get", "--status", status, sandboxName], 30000)
  return parseNetworkRules(String(stdout))
}

export async function getSandboxPermissionFeed(sandboxId: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  const [pending, approved, rejected] = await Promise.all([
    listRulesForStatus(resolved.name, "pending"),
    listRulesForStatus(resolved.name, "approved").catch(() => [] as SandboxNetworkRule[]),
    listRulesForStatus(resolved.name, "rejected").catch(() => [] as SandboxNetworkRule[]),
  ])

  return {
    sandboxId,
    sandboxName: resolved.name,
    pending,
    recent: [...pending, ...approved, ...rejected].slice(0, 8),
    pendingCount: pending.length,
    approvedCount: approved.length,
    rejectedCount: rejected.length,
    latest: pending[0] ? { status: "Pending", chunkId: pending[0].chunkId } : { status: "Ready" },
  }
}

export async function resolveSandboxNetworkRule(sandboxId: string, action: string, chunkId: string, reason = "") {
  if (!/^[a-f0-9-]{8,}$/i.test(chunkId)) throw new Error("invalid network rule chunk id")
  const resolved = await resolveSandboxRef(sandboxId)
  const command = action === "reject" ? "reject" : action === "approve" ? "approve" : ""
  if (!command) throw new Error("unsupported permission action")

  const args = ["rule", command, "--chunk-id", chunkId]
  if (command === "reject" && reason) args.push("--reason", reason)
  args.push(resolved.name)

  const { stdout, stderr } = await runOpenShell(args, 60000)
  const feed = await getSandboxPermissionFeed(resolved.name).catch(() => null)

  return {
    sandboxId,
    sandboxName: resolved.name,
    action: command,
    chunkId,
    stdout: String(stdout).trim(),
    stderr: String(stderr).trim(),
    feed,
  }
}

async function probeBrokerEndpoint(sandboxName: string, brokerBaseUrl: string) {
  const mcpUrl = `${brokerBaseUrl.replace(/\/+$/, "")}/mcp`
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openshell-control-mcp-policy-probe", version: "0" },
    },
  }
  const script = [
    "node",
    "--input-type=module",
    "-e",
    `
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        await fetch(${JSON.stringify(mcpUrl)}, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: ${JSON.stringify(JSON.stringify(payload))},
          signal: controller.signal,
        });
      } catch {
        // The probe only exists to let OpenShell create a policy chunk.
      } finally {
        clearTimeout(timeout);
      }
    `,
  ]
  await runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", ...script], 15000).catch(() => null)
}

export async function syncBrokerNetworkAccess(sandboxId: string, brokerBaseUrl: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  const candidates = brokerEndpointCandidates(brokerBaseUrl)
  await probeBrokerEndpoint(resolved.name, brokerBaseUrl)
  const pending = await listRulesForStatus(resolved.name, "pending").catch(() => [] as SandboxNetworkRule[])
  const matchingPending = pending.filter((rule) => ruleMatchesEndpoints(rule, candidates))
  const approved: BrokerNetworkAction[] = []

  for (const rule of matchingPending) {
    await resolveSandboxNetworkRule(resolved.name, "approve", rule.chunkId)
    approved.push({
      action: "approve",
      chunkId: rule.chunkId,
      endpoint: rule.endpoints.find((endpoint) => candidates.has(endpoint)) || Array.from(candidates)[0] || "",
      status: rule.status,
    })
  }

  const currentlyApproved = await listRulesForStatus(resolved.name, "approved").catch(() => [] as SandboxNetworkRule[])
  return {
    sandboxId,
    sandboxName: resolved.name,
    brokerBaseUrl,
    approved,
    alreadyApproved: currentlyApproved.filter((rule) => ruleMatchesEndpoints(rule, candidates)).map((rule) => ({
      chunkId: rule.chunkId,
      endpoints: rule.endpoints,
      status: rule.status,
    })),
  }
}

export async function revokeBrokerNetworkAccess(sandboxId: string, brokerBaseUrl: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  const candidates = brokerEndpointCandidates(brokerBaseUrl)
  const [pending, approved] = await Promise.all([
    listRulesForStatus(resolved.name, "pending").catch(() => [] as SandboxNetworkRule[]),
    listRulesForStatus(resolved.name, "approved").catch(() => [] as SandboxNetworkRule[]),
  ])
  const matching = [...pending, ...approved].filter((rule) => ruleMatchesEndpoints(rule, candidates))
  const rejected: BrokerNetworkAction[] = []

  for (const rule of matching) {
    await resolveSandboxNetworkRule(resolved.name, "reject", rule.chunkId, "MCP broker access revoked")
    rejected.push({
      action: "reject",
      chunkId: rule.chunkId,
      endpoint: rule.endpoints.find((endpoint) => candidates.has(endpoint)) || Array.from(candidates)[0] || "",
      status: rule.status,
    })
  }

  return {
    sandboxId,
    sandboxName: resolved.name,
    brokerBaseUrl,
    rejected,
  }
}
