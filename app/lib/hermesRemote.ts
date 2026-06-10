import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const SCRIPTS_DIR = path.join(process.cwd(), "scripts", "hermes-remote")
const ACCESS_DIR = process.env.HERMES_REMOTE_ACCESS_DIR || "/etc/openshell/hermes-access"

export type HermesRemoteMode = "desktop" | "web" | "off"

export type HermesRemoteAccess = {
  sandbox: string
  mode: string
  port: number
  token: string
  url: string
  publicHost: string
  hermesVersion: string
  updatedAt: string
}

export type HermesRemoteResult =
  | { ok: true; access: HermesRemoteAccess }
  | { ok: false; error: string }

// HERMES_REMOTE_MODE selects how Hermes sandboxes are exposed for the desktop
// app on this deployment. "desktop" (default) proxies only /api/* with a
// stable session token — the SPA shell (which embeds the token in its HTML)
// is never served publicly. "web" additionally proxies the SPA for browser
// use; only safe behind a Pangolin-gated resource or on trusted networks.
// "off" disables automatic exposure entirely.
export function hermesRemoteMode(): HermesRemoteMode {
  const raw = (process.env.HERMES_REMOTE_MODE || "desktop").trim().toLowerCase()
  return raw === "web" || raw === "off" ? raw : "desktop"
}

export function readHermesRemoteAccess(sandboxName: string): HermesRemoteAccess | null {
  const file = path.join(ACCESS_DIR, `${sandboxName}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as HermesRemoteAccess
  } catch {
    return null
  }
}

export async function exposeHermesRemote(sandboxName: string): Promise<HermesRemoteResult> {
  const mode = hermesRemoteMode()
  if (mode === "off") return { ok: false, error: "HERMES_REMOTE_MODE=off" }
  try {
    await execFileAsync("/bin/bash", [path.join(SCRIPTS_DIR, "expose.sh"), sandboxName, "--mode", mode], {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    const access = readHermesRemoteAccess(sandboxName)
    if (!access) return { ok: false, error: "expose.sh succeeded but no access record was written" }
    return { ok: true, access }
  } catch (error: any) {
    const stderr = String(error?.stderr || "").trim().split("\n").slice(-3).join(" | ")
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: stderr || message }
  }
}

export async function unexposeHermesRemote(sandboxName: string): Promise<{ ok: boolean; error?: string }> {
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
