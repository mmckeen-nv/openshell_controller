import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const OLLAMA_PORT = 11434

type Outcome =
  | { action: "ok"; reason: string }
  | { action: "killed"; pid: number; reclaimedBy: number }
  | { action: "killed-no-reclaim"; pid: number }
  | { action: "skipped"; reason: string }

async function listenerPid(): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ss", ["-ltnpH", `sport = :${OLLAMA_PORT}`], { timeout: 3000 })
    const match = String(stdout).match(/pid=(\d+)/)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function isManagedBySystemd(pid: number): Promise<boolean> {
  try {
    const cgroup = await readFile(`/proc/${pid}/cgroup`, "utf8")
    return cgroup.includes("ollama.service")
  } catch {
    return false
  }
}

// Cloud-init user-data on fresh deploys can launch `ollama serve` directly as root
// (binding 0.0.0.0:11434) before systemd's ollama.service takes over. When `nemoclaw
// onboard` then writes its loopback override and calls `systemctl restart ollama`,
// the rogue process keeps the port held — the systemd restart can't bind, the
// override never applies, and nemoclaw bails with "Failed to apply Ollama systemd
// loopback override". Detect that state and kill the rogue so systemd's restart
// loop reclaims the port cleanly. No-op when the listener is already managed by
// the unit (the normal post-reboot state).
export async function ensureSystemdOllama(): Promise<Outcome> {
  const pid = await listenerPid()
  if (!pid) return { action: "skipped", reason: "no listener on 11434" }

  if (await isManagedBySystemd(pid)) {
    return { action: "ok", reason: `pid=${pid} already in ollama.service cgroup` }
  }

  try {
    process.kill(pid, "SIGTERM")
  } catch (err) {
    return { action: "skipped", reason: `kill failed: ${(err as Error).message}` }
  }

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    const next = await listenerPid()
    if (next && next !== pid && (await isManagedBySystemd(next))) {
      return { action: "killed", pid, reclaimedBy: next }
    }
  }
  return { action: "killed-no-reclaim", pid }
}
