import { NextResponse } from "next/server"
import { restartSandboxGatewayWithNemoClaw } from "@/app/lib/nemoclawCli"
import { inspectSandbox, resolveSandboxRef } from "@/app/lib/openshellHost"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateSandboxName(value: string) {
  if (!value || value.length > 63) throw new Error("sandbox name is required")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) throw new Error("invalid sandbox name")
  return value
}


async function waitForSandboxReady(sandboxName: string, timeoutMs: number, intervalMs: number) {
  const startedAt = Date.now()
  let attempts = 0
  let lastError = ""

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
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const startedAt = Date.now()
  try {
    const { sandboxId } = await params
    const resolved = await resolveSandboxRef(sandboxId)
    const sandboxName = validateSandboxName(resolved.name)
    const readiness = await waitForSandboxReady(sandboxName, 15000, 1000)
    if (!readiness.ready) {
      return NextResponse.json({
        ok: false,
        restarted: false,
        sandboxId: resolved.id,
        sandboxName,
        readiness,
        elapsedMs: Date.now() - startedAt,
        note: "Sandbox was not Ready, so the dashboard runtime was not restarted.",
      }, { status: 409 })
    }

    const nemoclawRestart = await restartSandboxGatewayWithNemoClaw(sandboxName)
    if (nemoclawRestart.attempted && nemoclawRestart.ok) {
      return NextResponse.json({
        ok: true,
        restarted: true,
        restartMode: "nemoclaw-native-gateway",
        sandboxId: resolved.id,
        sandboxName,
        readiness,
        nemoclawRestart,
        elapsedMs: Date.now() - startedAt,
        note: "NemoClaw asked the sandbox's native agent to restart its gateway, then verified gateway health and host forwards.",
      })
    }

    return NextResponse.json({
      ok: false,
      restarted: false,
      restartMode: "nemoclaw-native-gateway",
      sandboxId: resolved.id,
      sandboxName,
      readiness,
      nemoclawRestart,
      elapsedMs: Date.now() - startedAt,
      note: nemoclawRestart.attempted
        ? "NemoClaw could not complete the native gateway restart. The controller did not bypass the agent-owned lifecycle boundary."
        : "The installed NemoClaw CLI does not support the native gateway restart command. Upgrade NemoClaw before retrying.",
    }, { status: nemoclawRestart.attempted ? 502 : 409 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart sandbox runtime"
    return NextResponse.json({ ok: false, restarted: false, error: message }, { status: /required|invalid/.test(message) ? 400 : 500 })
  }
}
