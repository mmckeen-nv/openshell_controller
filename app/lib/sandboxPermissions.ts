import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveSandboxRef } from "./openshellHost"

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || ""
const OPENSHELL_BIN = process.env.OPENSHELL_BIN || `${HOME}/.local/bin/openshell`
const HOST_PATH = [
  `${HOME}/.local/bin`,
  `${HOME}/.nvm/versions/node/v22.22.2/bin`,
  `${HOME}/.nvm/versions/node/v22.22.1/bin`,
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH || "",
].filter(Boolean).join(":")

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

function runOpenShell(args: string[], timeout = 60000) {
  return execFileAsync(OPENSHELL_BIN, args, {
    env: {
      ...process.env,
      PATH: HOST_PATH,
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      NO_COLOR: "1",
      CLICOLOR: "0",
      CLICOLOR_FORCE: "0",
      TERM: "dumb",
    },
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
