import { spawn } from "node:child_process"
import { HOST_PATH } from "./hostCommands"

const DOCKER_BIN = process.env.DOCKER_BIN || "docker"
const OPENSHELL_CLUSTER_CONTAINER = process.env.OPENSHELL_CLUSTER_CONTAINER || "openshell-cluster-nemoclaw"
const OPENSHELL_NAMESPACE = process.env.OPENSHELL_SANDBOX_NAMESPACE || "openshell"

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function runDockerKubectl(args: string[], input?: Buffer | string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
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

export async function writeSandboxFilePrivileged(
  sandboxName: string,
  targetPath: string,
  payload: Buffer,
  mode = "0644",
) {
  const script = [
    `mkdir -p ${shellQuote(targetPath.split("/").slice(0, -1).join("/") || "/")}`,
    `cat > ${shellQuote(targetPath)}`,
    `chmod ${shellQuote(mode)} ${shellQuote(targetPath)}`,
    `chown root:root ${shellQuote(targetPath)} 2>/dev/null || true`,
  ].join(" && ")
  const result = await runDockerKubectl(
    ["exec", "-i", "-n", OPENSHELL_NAMESPACE, sandboxName, "--", "sh", "-lc", script],
    payload,
  )
  if (result.code !== 0) throw new Error(result.stderr || `failed to write ${targetPath}`)
  return {
    sandboxName,
    path: targetPath,
    bytes: payload.byteLength,
  }
}

export async function repairOpenClawExecApprovalsFile(sandboxName: string) {
  const normalizeScript = [
    `const fs = require("fs")`,
    `const approval = "/sandbox/.openclaw/exec-approvals.json"`,
    `const tmp = process.argv[1]`,
    `let source = ""`,
    `try { source = fs.readFileSync(approval, "utf8") } catch {}`,
    `const trimmed = source.trim()`,
    `let payload = "{}\\n"`,
    `if (trimmed) { try { payload = JSON.stringify(JSON.parse(trimmed), null, 2) + "\\n" } catch {} }`,
    `fs.writeFileSync(tmp, payload)`,
  ].join("; ")
  const script = [
    `mkdir -p /sandbox/.openclaw`,
    `tmp="/sandbox/.openclaw/.exec-approvals.json.$$"`,
    `node -e ${shellQuote(normalizeScript)} "$tmp"`,
    `rm -f /sandbox/.openclaw/exec-approvals.json`,
    `mv "$tmp" /sandbox/.openclaw/exec-approvals.json`,
    `chown sandbox:sandbox /sandbox/.openclaw/exec-approvals.json 2>/dev/null || chown 998:998 /sandbox/.openclaw/exec-approvals.json`,
    `chmod 0600 /sandbox/.openclaw/exec-approvals.json`,
  ].join(" && ")
  const result = await runDockerKubectl(
    ["exec", "-n", OPENSHELL_NAMESPACE, sandboxName, "--", "sh", "-lc", script],
  )
  if (result.code !== 0) throw new Error(result.stderr || "failed to repair OpenClaw exec approvals file")
  return {
    sandboxName,
    path: "/sandbox/.openclaw/exec-approvals.json",
    note: "Replaced OpenClaw exec approvals symlink with a real sandbox-owned file for newer OpenClaw versions.",
  }
}

export async function stabilizeOpenClawGatewayConfig(sandboxName: string) {
  const patchConfig = [
    `const fs = require("fs")`,
    `const path = "/sandbox/.openclaw/openclaw.json"`,
    `const cfg = JSON.parse(fs.readFileSync(path, "utf8"))`,
    `cfg.plugins = cfg.plugins && typeof cfg.plugins === "object" && !Array.isArray(cfg.plugins) ? cfg.plugins : {}`,
    `cfg.plugins.entries = cfg.plugins.entries && typeof cfg.plugins.entries === "object" && !Array.isArray(cfg.plugins.entries) ? cfg.plugins.entries : {}`,
    `cfg.plugins.entries.bonjour = { ...(cfg.plugins.entries.bonjour || {}), enabled: false }`,
    `fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + "\\n")`,
  ].join("; ")
  const script = [
    `node -e ${shellQuote(patchConfig)}`,
    `chmod 444 /sandbox/.openclaw/openclaw.json`,
    `chown root:root /sandbox/.openclaw/openclaw.json`,
    `(cd /sandbox/.openclaw && sha256sum openclaw.json > .config-hash)`,
    `chmod 444 /sandbox/.openclaw/.config-hash`,
    `chown root:root /sandbox/.openclaw/.config-hash`,
    `mkdir -p /sandbox/.openclaw-data/logs`,
    `chown -R sandbox:sandbox /sandbox/.openclaw-data/logs 2>/dev/null || chown -R 998:998 /sandbox/.openclaw-data/logs`,
    `openclaw gateway stop >/dev/null 2>&1 || true`,
    `if command -v gosu >/dev/null 2>&1; then nohup gosu sandbox openclaw gateway run >/sandbox/.openclaw-data/logs/gateway.log 2>&1 & else nohup openclaw gateway run >/sandbox/.openclaw-data/logs/gateway.log 2>&1 & fi`,
  ].join(" && ")
  const result = await runDockerKubectl(
    ["exec", "-n", OPENSHELL_NAMESPACE, sandboxName, "--", "sh", "-lc", script],
  )
  if (result.code !== 0) throw new Error(result.stderr || "failed to stabilize OpenClaw gateway config")
  return {
    sandboxName,
    path: "/sandbox/.openclaw/openclaw.json",
    note: "Disabled the Bonjour gateway discovery plugin inside the sandbox because it crashes under the OpenShell network namespace.",
  }
}

export async function repairOpenClawWorkspacePermissions(sandboxName: string) {
  const mutableDirs = [
    "agents",
    "extensions",
    "workspace",
    "skills",
    "hooks",
    "identity",
    "devices",
    "canvas",
    "cron",
    "memory",
    "logs",
    "credentials",
    "flows",
    "sandbox",
    "telegram",
    "plugin-runtime-deps",
  ]
  const mutableFiles = [
    "update-check.json",
  ]
  const script = [
    `mkdir -p /sandbox/.openclaw /sandbox/.openclaw-data/agents/main/agent`,
    `for dir in ${mutableDirs.map(shellQuote).join(" ")}; do target="/sandbox/.openclaw-data/$dir"; link="/sandbox/.openclaw/$dir"; mkdir -p "$target"; if [ -d "$link" ] && [ ! -L "$link" ]; then cp -a "$link/." "$target/" 2>/dev/null || true; rm -rf "$link"; fi; ln -sfn "$target" "$link"; done`,
    `for file in ${mutableFiles.map(shellQuote).join(" ")}; do target="/sandbox/.openclaw-data/$file"; link="/sandbox/.openclaw/$file"; if [ ! -e "$target" ]; then if [ -f "$link" ] && [ ! -L "$link" ]; then cp "$link" "$target" 2>/dev/null || : > "$target"; else : > "$target"; fi; fi; if [ -e "$link" ] && [ ! -L "$link" ]; then rm -f "$link"; fi; ln -sfn "$target" "$link"; done`,
    `approval="/sandbox/.openclaw/exec-approvals.json"; approval_data="/sandbox/.openclaw-data/exec-approvals.json"; tmp="/sandbox/.openclaw/.exec-approvals.reconcile.$$"; if [ -L "$approval" ]; then if [ -s "$approval_data" ]; then cp "$approval_data" "$tmp" 2>/dev/null || : > "$tmp"; else : > "$tmp"; fi; rm -f "$approval"; mv "$tmp" "$approval"; elif [ ! -e "$approval" ]; then : > "$approval"; fi`,
    `chown -R sandbox:sandbox /sandbox/.openclaw-data 2>/dev/null || chown -R 998:998 /sandbox/.openclaw-data`,
    `chown sandbox:sandbox /sandbox/.openclaw /sandbox/.openclaw/exec-approvals.json 2>/dev/null || chown 998:998 /sandbox/.openclaw /sandbox/.openclaw/exec-approvals.json`,
    `chmod 0755 /sandbox/.openclaw && chmod 0600 /sandbox/.openclaw/exec-approvals.json`,
  ].join(" && ")
  const result = await runDockerKubectl(
    ["exec", "-n", OPENSHELL_NAMESPACE, sandboxName, "--", "sh", "-lc", script],
  )
  if (result.code !== 0) throw new Error(result.stderr || "failed to repair OpenClaw mutable paths")
  return {
    sandboxName,
    path: "/sandbox/.openclaw",
    target: "/sandbox/.openclaw-data",
    mutableDirs,
    mutableFiles,
    note: "Reconciled the OpenClaw directory layout for NemoClaw: mutable state paths, AGENTS.md, session locks, update-check state, plugin runtime deps, and exec approvals are writable where the bundled OpenClaw expects them.",
  }
}
