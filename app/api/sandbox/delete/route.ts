import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveSandboxRef } from "@/app/lib/openshellHost"

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

function parseDeleteTarget(body: any) {
  const raw = typeof body?.sandboxName === "string"
    ? body.sandboxName.trim()
    : typeof body?.sandboxId === "string"
      ? body.sandboxId.trim()
      : ""
  if (!raw) throw new Error("sandbox name or id is required")
  return raw
}

async function resolveDeleteTarget(ref: string) {
  try {
    const sandbox = await resolveSandboxRef(ref)
    return {
      requested: ref,
      sandboxName: validateSandboxName(sandbox.name),
      sandboxId: sandbox.id,
      resolved: true,
    }
  } catch (error) {
    return {
      requested: ref,
      sandboxName: validateSandboxName(ref),
      sandboxId: null,
      resolved: false,
      resolveError: error instanceof Error ? error.message : String(error ?? "Sandbox lookup failed"),
    }
  }
}

async function deleteSandbox(sandboxName: string) {
  const startedAt = Date.now()
  console.log(`[sandbox/delete] command:start sandbox=${sandboxName}`)
  try {
    const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, ["sandbox", "delete", sandboxName], {
      env: {
        ...process.env,
        PATH: HOST_PATH,
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
        NO_COLOR: "1",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      },
      timeout: 60000,
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

async function waitForSandboxDeleted(sandboxName: string, timeoutMs: number, intervalMs: number) {
  const startedAt = Date.now()
  let attempts = 0
  let lastError: string | null = null

  while (elapsedMs(startedAt) < timeoutMs) {
    attempts += 1
    try {
      await resolveSandboxRef(sandboxName)
    } catch (error) {
      return {
        deleted: true as const,
        attempts,
        elapsedMs: elapsedMs(startedAt),
        lastError: error instanceof Error ? error.message : String(error ?? "Sandbox lookup failed"),
      }
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  try {
    await resolveSandboxRef(sandboxName)
  } catch (error) {
    return {
      deleted: true as const,
      attempts,
      elapsedMs: elapsedMs(startedAt),
      lastError: error instanceof Error ? error.message : String(error ?? "Sandbox lookup failed"),
    }
  }

  return {
    deleted: false as const,
    attempts,
    elapsedMs: elapsedMs(startedAt),
    lastError,
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now()
  console.log("[sandbox/delete] request:start")
  try {
    const body = await request.json()
    const target = await resolveDeleteTarget(parseDeleteTarget(body))
    const result = await deleteSandbox(target.sandboxName)
    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        deleted: false,
        requested: target.requested,
        sandboxName: target.sandboxName,
        sandboxId: target.sandboxId,
        resolved: target.resolved,
        resolveError: target.resolveError,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
      }, { status: 500 })
    }

    const deletion = await waitForSandboxDeleted(target.sandboxName, 45000, 1500)
    const deleted = deletion.deleted
    console.log(`[sandbox/delete] request:complete sandbox=${target.sandboxName} deleted=${deleted} elapsedMs=${elapsedMs(startedAt)}`)
    return NextResponse.json({
      ok: deleted,
      deleted,
      requested: target.requested,
      sandboxName: target.sandboxName,
      sandboxId: target.sandboxId,
      resolved: target.resolved,
      stdout: result.stdout,
      stderr: result.stderr,
      deletion,
      note: deleted ? "Sandbox delete completed and inventory no longer reports it." : "Sandbox delete command completed, but inventory still reports the sandbox.",
    }, { status: deleted ? 200 : 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox delete failed"
    const status = /required|must be|too long|name or id/.test(message) ? 400 : 500
    console.log(`[sandbox/delete] request:error elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return NextResponse.json({ ok: false, deleted: false, error: message }, { status })
  }
}
