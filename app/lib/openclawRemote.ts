import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const SCRIPTS_DIR = path.join(process.cwd(), "scripts", "openclaw-remote")
const ACCESS_DIR = process.env.OPENCLAW_REMOTE_ACCESS_DIR || "/etc/openshell/openclaw-access"

// Written by scripts/openclaw-remote/expose.sh. The OpenClaw mobile apps
// connect to host:port (443) over wss:// and authenticate with the gateway
// shared-secret token (sent in the WS connect frame), then complete device
// pairing approved on the gateway host.
export type OpenClawRemoteAccess = {
  sandbox: string
  gatewayPort: number
  hostPort: number
  token: string
  host: string
  port: number
  url: string
  updatedAt: string
}

export type OpenClawRemoteResult =
  | { ok: true; access: OpenClawRemoteAccess }
  | { ok: false; error: string }

export function readOpenClawRemoteAccess(sandboxName: string): OpenClawRemoteAccess | null {
  const file = path.join(ACCESS_DIR, `${sandboxName}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as OpenClawRemoteAccess
  } catch {
    return null
  }
}

export async function exposeOpenClawRemote(sandboxName: string): Promise<OpenClawRemoteResult> {
  try {
    await execFileAsync("/bin/bash", [path.join(SCRIPTS_DIR, "expose.sh"), sandboxName], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const access = readOpenClawRemoteAccess(sandboxName)
    if (!access) return { ok: false, error: "expose.sh succeeded but no access record was written" }
    return { ok: true, access }
  } catch (error: any) {
    const stderr = String(error?.stderr || "").trim().split("\n").slice(-3).join(" | ")
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: stderr || message }
  }
}

export async function unexposeOpenClawRemote(sandboxName: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await execFileAsync("/bin/bash", [path.join(SCRIPTS_DIR, "unexpose.sh"), sandboxName], {
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true }
  } catch (error: any) {
    const stderr = String(error?.stderr || "").trim().split("\n").slice(-3).join(" | ")
    return { ok: false, error: stderr || (error instanceof Error ? error.message : String(error)) }
  }
}
