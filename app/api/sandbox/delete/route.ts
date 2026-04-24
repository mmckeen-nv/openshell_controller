import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || ""
const OPENSHELL_BIN = process.env.OPENSHELL_BIN || `${HOME}/.local/bin/openshell`
const HOST_PATH = [
  `${HOME}/.local/bin`,
  `${HOME}/.nvm/versions/node/v22.22.2/bin`,
  `${HOME}/.nvm/versions/node/v22.22.1/bin`,
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  process.env.PATH || "",
].filter(Boolean).join(":")

function elapsedMs(start: number) {
  return Date.now() - start
}

function validateSandboxName(name: string) {
  if (!name || typeof name !== "string") throw new Error("sandbox name is required")
  if (name.length > 63) throw new Error("sandbox name too long (max 63 chars)")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error("sandbox name must be lowercase alphanumeric with optional internal hyphens")
  }
  return name
}

async function deleteSandbox(sandboxName: string) {
  const startedAt = Date.now()
  console.log(`[sandbox/delete] command:start sandbox=${sandboxName}`)
  try {
    const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, ["sandbox", "delete", sandboxName], {
      env: {
        ...process.env,
        PATH: HOST_PATH,
        NO_COLOR: "1",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      },
      maxBuffer: 20 * 1024 * 1024,
    })
    console.log(`[sandbox/delete] command:done sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)}`)
    return { ok: true as const, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error ?? "Sandbox delete failed")
    console.log(`[sandbox/delete] command:error sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return {
      ok: false as const,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim(),
      error: message,
    }
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now()
  console.log("[sandbox/delete] request:start")
  try {
    const body = await request.json()
    const sandboxName = validateSandboxName(
      typeof body?.sandboxName === "string" ? body.sandboxName.trim() : typeof body?.sandboxId === "string" ? body.sandboxId.trim() : "",
    )
    const result = await deleteSandbox(sandboxName)
    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        deleted: false,
        sandboxName,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
      }, { status: 500 })
    }

    console.log(`[sandbox/delete] request:complete sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)}`)
    return NextResponse.json({
      ok: true,
      deleted: true,
      sandboxName,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox delete failed"
    const status = /required|must be|too long/.test(message) ? 400 : 500
    console.log(`[sandbox/delete] request:error elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return NextResponse.json({ ok: false, deleted: false, error: message }, { status })
  }
}
