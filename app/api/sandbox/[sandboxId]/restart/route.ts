import { NextResponse } from "next/server"
import { spawn } from "node:child_process"
import { inspectSandbox, resolveSandboxRef } from "@/app/lib/openshellHost"

const DOCKER_BIN = process.env.DOCKER_BIN || "docker"
const OPENSHELL_CLUSTER_CONTAINER = process.env.OPENSHELL_CLUSTER_CONTAINER || "openshell-cluster-nemoclaw"
const OPENSHELL_SANDBOX_NAMESPACE = process.env.OPENSHELL_SANDBOX_NAMESPACE || "openshell"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateSandboxName(value: string) {
  if (!value || value.length > 63) throw new Error("sandbox name is required")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) throw new Error("invalid sandbox name")
  return value
}

async function runKubectl(args: string[]) {
  return await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(DOCKER_BIN, ["exec", OPENSHELL_CLUSTER_CONTAINER, "kubectl", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += String(chunk) })
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code }))
  })
}

async function waitForSandboxReady(sandboxName: string, timeoutMs: number, intervalMs: number) {
  const startedAt = Date.now()
  let attempts = 0
  let lastError: string | null = null

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1
    try {
      const inspection = await inspectSandbox(sandboxName)
      if (inspection.rawPhase === "Ready") {
        return { ready: true, attempts, elapsedMs: Date.now() - startedAt, inspection }
      }
      lastError = `sandbox phase ${inspection.rawPhase || inspection.phase || "unknown"}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error ?? "Sandbox lookup failed")
    }
    await sleep(intervalMs)
  }

  return { ready: false, attempts, elapsedMs: Date.now() - startedAt, lastError }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  const startedAt = Date.now()
  try {
    const { sandboxId } = await params
    const resolved = await resolveSandboxRef(sandboxId)
    const sandboxName = validateSandboxName(resolved.name)
    const deleted = await runKubectl(["delete", "pod", sandboxName, "-n", OPENSHELL_SANDBOX_NAMESPACE, "--wait=false"])
    if (deleted.code !== 0 && !/not found/i.test(`${deleted.stdout}\n${deleted.stderr}`)) {
      throw new Error(deleted.stderr || deleted.stdout || "Failed to restart sandbox pod")
    }

    const readiness = await waitForSandboxReady(sandboxName, 90000, 2000)
    return NextResponse.json({
      ok: readiness.ready,
      restarted: readiness.ready,
      sandboxId: resolved.id,
      sandboxName,
      deletion: deleted,
      readiness,
      elapsedMs: Date.now() - startedAt,
      note: readiness.ready
        ? "Sandbox pod restarted and OpenShell reports it Ready."
        : "Restart was requested, but OpenShell has not reported the sandbox Ready yet.",
    }, { status: readiness.ready ? 200 : 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart sandbox"
    return NextResponse.json({ ok: false, restarted: false, error: message }, { status: /required|invalid/.test(message) ? 400 : 500 })
  }
}
