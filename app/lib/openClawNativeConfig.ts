import { spawn } from "node:child_process"
import { OPENSHELL_BIN, hostCommandEnv } from "./hostCommands"

export type OpenClawConfigPatch = Record<string, unknown>

export function applyNativeOpenClawConfigPatch(
  sandboxName: string,
  patch: OpenClawConfigPatch,
  timeoutMs = 60000,
) {
  const payload = JSON.stringify(patch)
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(
      OPENSHELL_BIN,
      [
        "sandbox",
        "exec",
        "-n",
        sandboxName,
        "--env",
        "HOME=/sandbox",
        "--",
        "openclaw",
        "config",
        "patch",
        "--stdin",
      ],
      {
        env: hostCommandEnv({
          OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY?.trim() || undefined,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code })
    })
    child.stdin.end(payload)
  })
}

export async function writeNativeOpenClawConfigPatch(
  sandboxName: string,
  patch: OpenClawConfigPatch,
  failureMessage: string,
) {
  const result = await applyNativeOpenClawConfigPatch(sandboxName, patch)
  if (result.code !== 0) throw new Error(result.stderr || failureMessage)
  return result
}
