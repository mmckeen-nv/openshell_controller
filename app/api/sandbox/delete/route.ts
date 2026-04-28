import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveSandboxRef } from "@/app/lib/openshellHost"
import { NEMOCLAW_BIN, NEMOCLAW_CWD, OPENSHELL_BIN, hostCommandEnv } from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)

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
      env: hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      }),
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

function isSandboxNotFound(output: string) {
  return /sandbox not found|status:\s*NotFound|not present in the live OpenShell gateway/i.test(output)
}

function isNemoClawSandboxNotRegistered(output: string, sandboxName: string) {
  return new RegExp(`Unknown command:\\s*${sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(output)
}

async function cleanupNemoClawSandbox(sandboxName: string) {
  const startedAt = Date.now()
  console.log(`[sandbox/delete] nemoclaw-cleanup:start sandbox=${sandboxName}`)
  try {
    const { stdout, stderr } = await execFileAsync(NEMOCLAW_BIN, [sandboxName, "destroy", "--yes"], {
      cwd: NEMOCLAW_CWD,
      env: hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      }),
      timeout: 90000,
      maxBuffer: 20 * 1024 * 1024,
    })
    console.log(`[sandbox/delete] nemoclaw-cleanup:done sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)}`)
    return { ok: true as const, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error ?? "NemoClaw cleanup failed")
    const stdout = String(error?.stdout || "").trim()
    const stderr = String(error?.stderr || "").trim()
    const output = [message, stdout, stderr].filter(Boolean).join("\n")
    if (isNemoClawSandboxNotRegistered(output, sandboxName)) {
      console.log(`[sandbox/delete] nemoclaw-cleanup:already-gone sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)}`)
      return {
        ok: true as const,
        stdout,
        stderr,
        note: "NemoClaw registry already had no matching sandbox.",
      }
    }
    console.log(`[sandbox/delete] nemoclaw-cleanup:error sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return {
      ok: false as const,
      stdout,
      stderr,
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
    const deleteOutput = [result.error, result.stdout, result.stderr].filter(Boolean).join("\n")
    const openShellAlreadyGone = !result.ok && isSandboxNotFound(deleteOutput)
    const cleanup = await cleanupNemoClawSandbox(target.sandboxName)

    if (!result.ok && !openShellAlreadyGone) {
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
        nemoclaw: cleanup,
      }, { status: 500 })
    }

    if (!cleanup.ok) {
      return NextResponse.json({
        ok: false,
        deleted: false,
        requested: target.requested,
        sandboxName: target.sandboxName,
        sandboxId: target.sandboxId,
        resolved: target.resolved,
        openShellAlreadyGone,
        openShell: result,
        error: cleanup.error,
        stdout: cleanup.stdout,
        stderr: cleanup.stderr,
        nemoclaw: cleanup,
      }, { status: 500 })
    }

    const deletion = await waitForSandboxDeleted(target.sandboxName, 45000, 1500)
    const deleted = deletion.deleted || openShellAlreadyGone
    console.log(`[sandbox/delete] request:complete sandbox=${target.sandboxName} deleted=${deleted} elapsedMs=${elapsedMs(startedAt)}`)
    return NextResponse.json({
      ok: deleted,
      deleted,
      requested: target.requested,
      sandboxName: target.sandboxName,
      sandboxId: target.sandboxId,
      resolved: target.resolved,
      stdout: [result.stdout, cleanup.stdout].filter(Boolean).join("\n\n"),
      stderr: [result.stderr, cleanup.stderr].filter(Boolean).join("\n\n"),
      openShellAlreadyGone,
      openShell: result,
      nemoclaw: cleanup,
      deletion,
      note: deleted ? "Sandbox delete completed and NemoClaw registry cleanup ran." : "Sandbox delete command completed, but inventory still reports the sandbox.",
    }, { status: deleted ? 200 : 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox delete failed"
    const status = /required|must be|too long|name or id/.test(message) ? 400 : 500
    console.log(`[sandbox/delete] request:error elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return NextResponse.json({ ok: false, deleted: false, error: message }, { status })
  }
}
