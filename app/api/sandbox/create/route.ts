import { NextResponse } from "next/server"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { inspectSandbox } from "@/app/lib/openshellHost"

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || ""
const NEMOCLAW_SETUP = process.env.NEMOCLAW_SETUP || `${HOME}/NemoClaw/scripts/setup.sh`
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

function validateSandboxName(name: string) {
  if (!name || typeof name !== "string") throw new Error("sandbox name is required")
  if (name.length > 63) throw new Error("sandbox name too long (max 63 chars)")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new Error("sandbox name must be lowercase alphanumeric with optional internal hyphens")
  }
  return name
}

type SandboxVerification = {
  verified: boolean
  summary: string
  details?: {
    name: string
    id: string | null
    phase: string | null
    namespace: string | null
    sshHostAlias: string
    rawPhase: string | null
    rawDetails: string
  }
  error?: string
}

const AUTHORITATIVE_SUCCESS_PHASE = "Ready"
const NO_PENDING_DEVICE_REQUESTS = /no pending device pairing requests/i

function elapsedMs(start: number) {
  return Date.now() - start
}

function appendNote(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ")
}

async function verifySandboxCreation(sandboxName: string): Promise<SandboxVerification> {
  const startedAt = Date.now()
  console.log(`[sandbox/create] verify:start sandbox=${sandboxName}`)
  try {
    const sandbox = await inspectSandbox(sandboxName)
    const phase = sandbox.phase ?? "Unknown"
    const rawPhase = sandbox.rawPhase ?? "Unknown"
    const verified = rawPhase === AUTHORITATIVE_SUCCESS_PHASE
    console.log(
      `[sandbox/create] verify:done sandbox=${sandboxName} rawPhase=${rawPhase} normalizedPhase=${phase} verified=${verified} elapsedMs=${elapsedMs(startedAt)}`,
    )

    return {
      verified,
      summary: verified
        ? `Verified via openshell sandbox get with authoritative phase (${rawPhase}).`
        : `Sandbox lookup succeeded, but authoritative phase was not ready (${rawPhase}); normalized phase=${phase}.`,
      details: {
        name: sandbox.name,
        id: sandbox.id,
        phase: sandbox.phase,
        namespace: sandbox.namespace,
        sshHostAlias: sandbox.sshHostAlias,
        rawPhase: sandbox.rawPhase,
        rawDetails: sandbox.rawDetails,
      },
      ...(verified ? {} : { error: `Sandbox authoritative phase ${rawPhase} is not the required success state ${AUTHORITATIVE_SUCCESS_PHASE}.` }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "Sandbox verification failed")
    console.log(`[sandbox/create] verify:error sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return {
      verified: false,
      summary: "Create command returned success, but post-create authoritative verification failed.",
      error: message,
    }
  }
}

async function runCommand(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const startedAt = Date.now()
  console.log(`[sandbox/create] command:start file=${file} args=${JSON.stringify(args)}`)
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      env,
      maxBuffer: 20 * 1024 * 1024,
    })
    console.log(`[sandbox/create] command:done file=${file} elapsedMs=${elapsedMs(startedAt)} stdoutBytes=${String(stdout).length} stderrBytes=${String(stderr).length}`)
    return { ok: true as const, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error ?? "Command failed")
    console.log(
      `[sandbox/create] command:error file=${file} elapsedMs=${elapsedMs(startedAt)} message=${message} stdoutBytes=${String(error?.stdout || "").length} stderrBytes=${String(error?.stderr || "").length}`,
    )
    return {
      ok: false as const,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim(),
      error: message,
    }
  }
}

async function runCreateCommandBounded(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  const startedAt = Date.now()
  console.log(`[sandbox/create] bounded-command:start file=${file} args=${JSON.stringify(args)} timeoutMs=${timeoutMs}`)

  return await new Promise<{
    completed: boolean
    timedOut: boolean
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    error?: string
  }>((resolve) => {
    const child = spawn(file, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false

    const finish = (result: {
      completed: boolean
      timedOut: boolean
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      error?: string
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })

    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error ?? "Command failed")
      console.log(`[sandbox/create] bounded-command:error file=${file} elapsedMs=${elapsedMs(startedAt)} message=${message}`)
      finish({
        completed: false,
        timedOut: false,
        exitCode: null,
        signal: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: message,
      })
    })

    child.on("close", (code, signal) => {
      console.log(`[sandbox/create] bounded-command:close file=${file} elapsedMs=${elapsedMs(startedAt)} code=${code} signal=${signal} stdoutBytes=${stdout.length} stderrBytes=${stderr.length}`)
      finish({
        completed: true,
        timedOut: false,
        exitCode: code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ...(code === 0 ? {} : { error: `Command exited with code ${code}${signal ? ` signal ${signal}` : ""}` }),
      })
    })

    const timer = setTimeout(() => {
      console.log(`[sandbox/create] bounded-command:timeout file=${file} elapsedMs=${elapsedMs(startedAt)} sending=SIGTERM`)
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!settled) {
          console.log(`[sandbox/create] bounded-command:timeout-escalate file=${file} elapsedMs=${elapsedMs(startedAt)} sending=SIGKILL`)
          child.kill("SIGKILL")
        }
      }, 2000)
      finish({
        completed: false,
        timedOut: true,
        exitCode: null,
        signal: "SIGTERM",
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: `Command exceeded timeout of ${timeoutMs}ms`,
      })
    }, timeoutMs)
  })
}

async function approveOpenClawDeviceRequests(sandboxName: string) {
  const result = await runCreateCommandBounded(OPENSHELL_BIN, [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    "--",
    "sh",
    "-lc",
    "openclaw devices approve --latest --json --timeout 10000",
  ], {
    ...process.env,
    PATH: HOST_PATH,
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  }, 15000)

  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim()
  const noPending = NO_PENDING_DEVICE_REQUESTS.test(combinedOutput)
  return {
    attempted: true,
    approved: result.completed && result.exitCode === 0,
    noPending,
    completed: result.completed,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: noPending ? undefined : result.error,
    note: result.completed && result.exitCode === 0
      ? "Ran openclaw devices approve --latest inside the sandbox."
      : noPending
        ? "Ran openclaw devices approve --latest inside the sandbox; no pending device pairing requests were present."
        : "Attempted openclaw device approval inside the sandbox, but it did not complete successfully.",
  }
}

async function waitForSandboxReady(sandboxName: string, timeoutMs: number, intervalMs: number) {
  const startedAt = Date.now()
  let lastVerification: SandboxVerification | null = null
  let attempts = 0

  while (elapsedMs(startedAt) < timeoutMs) {
    attempts += 1
    lastVerification = await verifySandboxCreation(sandboxName)
    console.log(`[sandbox/create] readiness:attempt sandbox=${sandboxName} attempt=${attempts} verified=${lastVerification.verified} elapsedMs=${elapsedMs(startedAt)}`)
    if (lastVerification.verified) {
      return {
        verified: true as const,
        verification: lastVerification,
        attempts,
        elapsedMs: elapsedMs(startedAt),
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  return {
    verified: false as const,
    verification: lastVerification,
    attempts,
    elapsedMs: elapsedMs(startedAt),
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    blueprints: [
      {
        id: "nemoclaw-blueprint",
        label: "New NemoClaw Sandbox",
        description: "Bootstraps a full NemoClaw sandbox using the nemoclaw-blueprint workflow.",
        type: "blueprint",
        source: "~/NemoClaw/nemoclaw-blueprint/blueprint.yaml",
        supportsTailscale: true,
      },
      {
        id: "custom-sandbox",
        label: "New Custom Sandbox",
        description: "Create a generic OpenShell sandbox with a custom policy path.",
        type: "custom",
        source: "dashboard-custom",
        supportsTailscale: false,
      },
    ],
  })
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now()
  console.log(`[sandbox/create] request:start elapsedMs=0`)
  try {
    const body = await request.json()
    const blueprint = typeof body?.blueprint === "string" ? body.blueprint : ""
    const sandboxName = validateSandboxName(typeof body?.sandboxName === "string" ? body.sandboxName.trim() : "")
    const policy = body?.policy && typeof body.policy === "object" ? body.policy : null
    const enableTailscale = Boolean(body?.enableTailscale)
    console.log(`[sandbox/create] request:parsed sandbox=${sandboxName} blueprint=${blueprint} enableTailscale=${enableTailscale} elapsedMs=${elapsedMs(requestStartedAt)}`)

    if (!blueprint) {
      return NextResponse.json({ ok: false, error: "blueprint is required" }, { status: 400 })
    }

    if (blueprint === "nemoclaw-blueprint") {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: HOST_PATH,
        NEMOCLAW_SANDBOX_NAME: sandboxName,
      }

      if (!enableTailscale) {
        env.NVIDIA_API_KEY = env.NVIDIA_API_KEY || "optional-local-mode"
      }

      const result = await runCommand("/bin/bash", [NEMOCLAW_SETUP, sandboxName], env)

      if (!result.ok) {
        return NextResponse.json({
          ok: false,
          error: result.error,
          stdout: result.stdout,
          stderr: result.stderr,
          blueprint,
          sandboxName,
          enableTailscale,
        }, { status: 500 })
      }

      const readiness = await waitForSandboxReady(sandboxName, 90000, 2000)
      const verification = readiness.verification ?? {
        verified: false,
        summary: "Sandbox readiness polling produced no verification result.",
        error: "Sandbox readiness polling produced no verification result.",
      }
      const created = readiness.verified
      const deviceApproval = created ? await approveOpenClawDeviceRequests(sandboxName) : null
      console.log(
        `[sandbox/create] request:complete sandbox=${sandboxName} created=${created} readinessAttempts=${readiness.attempts} deviceApproval=${deviceApproval?.approved ?? false} elapsedMs=${elapsedMs(requestStartedAt)}`,
      )

      return NextResponse.json({
        ok: created,
        blueprint,
        sandboxName,
        created,
        verified: verification.verified,
        verification,
        mode: "nemoclaw-blueprint",
        enableTailscale,
        setupPath: NEMOCLAW_SETUP,
        hostPath: HOST_PATH,
        readiness: {
          attempts: readiness.attempts,
          elapsedMs: readiness.elapsedMs,
        },
        deviceApproval,
        stdout: result.stdout,
        stderr: result.stderr,
        note: created
          ? appendNote(
              enableTailscale
                ? "NemoClaw blueprint workflow completed with Tailscale-enabled prerequisites. Existing healthy OpenShell gateways are reused before any new gateway start is attempted."
                : "NemoClaw blueprint workflow completed in local/default mode. Existing healthy OpenShell gateways are reused before any new gateway start is attempted.",
              deviceApproval?.note,
            )
          : "Blueprint command reported success, but the sandbox never reached a ready verification state afterward.",
      }, { status: created ? 200 : 502 })
    }

    if (blueprint === "custom-sandbox") {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: HOST_PATH,
        NO_COLOR: "1",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      }
      const createAttempt = await runCreateCommandBounded(OPENSHELL_BIN, ["sandbox", "create", "--name", sandboxName], env, 15000)

      if (createAttempt.completed && createAttempt.exitCode !== 0) {
        return NextResponse.json({
          ok: false,
          error: createAttempt.error ?? `create command failed with exit code ${createAttempt.exitCode}`,
          stdout: createAttempt.stdout,
          stderr: createAttempt.stderr,
          blueprint,
          sandboxName,
        }, { status: 500 })
      }

      const readiness = await waitForSandboxReady(sandboxName, 90000, 2000)
      const verification = readiness.verification ?? {
        verified: false,
        summary: "Sandbox readiness polling produced no verification result.",
        error: "Sandbox readiness polling produced no verification result.",
      }
      const created = readiness.verified
      const deviceApproval = created ? await approveOpenClawDeviceRequests(sandboxName) : null
      const policyPrepared = Boolean(policy)
      console.log(
        `[sandbox/create] request:complete sandbox=${sandboxName} created=${created} createTimedOut=${createAttempt.timedOut} readinessAttempts=${readiness.attempts} deviceApproval=${deviceApproval?.approved ?? false} elapsedMs=${elapsedMs(requestStartedAt)}`,
      )
      return NextResponse.json({
        ok: created,
        blueprint,
        sandboxName,
        created,
        verified: verification.verified,
        verification,
        mode: "custom-sandbox",
        stdout: createAttempt.stdout,
        stderr: createAttempt.stderr,
        createCommand: {
          completed: createAttempt.completed,
          timedOut: createAttempt.timedOut,
          exitCode: createAttempt.exitCode,
          signal: createAttempt.signal,
          error: createAttempt.error,
        },
        readiness: {
          attempts: readiness.attempts,
          elapsedMs: readiness.elapsedMs,
        },
        deviceApproval,
        policyPrepared,
        note: created
          ? appendNote(
              createAttempt.timedOut
                ? "Custom sandbox reached Ready even though the create CLI did not exit promptly."
                : (policyPrepared
                    ? "Custom sandbox created. Policy draft is prepared, but applying it live should be a follow-up action."
                    : "Custom sandbox created."),
              deviceApproval?.note,
            )
          : "Create command started, but the sandbox never reached a ready verification state afterward.",
      }, { status: created ? 200 : 502 })
    }

    return NextResponse.json({ ok: false, error: `unknown blueprint: ${blueprint}` }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox creation failed"
    const status = /required|must be|too long|unknown blueprint/.test(message) ? 400 : 500
    console.log(`[sandbox/create] request:error elapsedMs=${elapsedMs(requestStartedAt)} message=${message}`)
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
