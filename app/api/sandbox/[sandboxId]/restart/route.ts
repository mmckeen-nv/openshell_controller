import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { OPENSHELL_BIN, hostCommandEnv } from "@/app/lib/hostCommands"
import { inspectSandbox, resolveSandboxRef } from "@/app/lib/openshellHost"

const execFileAsync = promisify(execFile)
const SANDBOX_DASHBOARD_REMOTE_PORT = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT || "18789", 10)

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateSandboxName(value: string) {
  if (!value || value.length > 63) throw new Error("sandbox name is required")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(value)) throw new Error("invalid sandbox name")
  return value
}

async function runOpenShell(args: string[], timeout = 30000) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
    }),
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  })
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

async function runSandboxShell(sandboxName: string, script: string, timeout = 30000) {
  return runOpenShell(["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", script], timeout)
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

function restartOpenClawGatewayScript() {
  return [
    `port=${SANDBOX_DASHBOARD_REMOTE_PORT}`,
    "for p in /proc/[0-9]*; do",
    "  cmd=$(tr '\\0' ' ' < \"$p/cmdline\" 2>/dev/null || true)",
    "  case \"$cmd\" in",
    "    *'openclaw gateway run'*) kill \"${p##*/}\" 2>/dev/null || true ;;",
    "  esac",
    "done",
    "sleep 1",
    "if command -v openclaw >/dev/null 2>&1; then openclaw_bin=$(command -v openclaw);",
    "elif [ -x /usr/local/bin/openclaw ]; then openclaw_bin=/usr/local/bin/openclaw;",
    "else echo 'openclaw command not found in sandbox' >&2; exit 127; fi",
    "nohup \"$openclaw_bin\" gateway run --allow-unconfigured --bind loopback --port \"$port\" >/tmp/gateway.log 2>&1 &",
    "for i in 1 2 3 4 5 6 7 8 9 10; do",
    "  curl -fsS --max-time 2 \"http://127.0.0.1:$port/\" >/dev/null 2>&1 && exit 0",
    "  sleep 1",
    "done",
    "echo 'OpenClaw gateway did not answer after restart. Last log lines:' >&2",
    "tail -40 /tmp/gateway.log >&2 2>/dev/null || true",
    "exit 1",
  ].join("\n")
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

    const runtime = await runSandboxShell(sandboxName, restartOpenClawGatewayScript(), 45000)

    return NextResponse.json({
      ok: true,
      restarted: true,
      restartMode: "openclaw-runtime",
      sandboxId: resolved.id,
      sandboxName,
      readiness,
      runtime,
      elapsedMs: Date.now() - startedAt,
      note: "OpenClaw runtime restarted inside the sandbox. The sandbox pod was not deleted.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart sandbox runtime"
    return NextResponse.json({ ok: false, restarted: false, error: message }, { status: /required|invalid/.test(message) ? 400 : 500 })
  }
}
