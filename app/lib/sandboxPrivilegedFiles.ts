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
    "sandbox",
    "telegram",
  ]
  const script = [
    `for dir in ${mutableDirs.map(shellQuote).join(" ")}; do target="/sandbox/.openclaw-data/$dir"; link="/sandbox/.openclaw/$dir"; mkdir -p "$target"; if [ -d "$link" ] && [ ! -L "$link" ]; then cp -a "$link/." "$target/" 2>/dev/null || true; rm -rf "$link"; fi; ln -sfn "$target" "$link"; done`,
    `chown -R sandbox:sandbox /sandbox/.openclaw-data 2>/dev/null || chown -R 998:998 /sandbox/.openclaw-data`,
    `for dir in ${mutableDirs.map(shellQuote).join(" ")}; do chmod 0775 "/sandbox/.openclaw-data/$dir"; done`,
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
    note: "Repaired OpenClaw mutable paths so AGENTS.md, session lock, and agent state writes resolve into writable .openclaw-data storage.",
  }
}
