import { NextResponse } from "next/server"
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { inspectSandbox, prebuildHermesDashboardWebUi, resolveSandboxRef } from "@/app/lib/openshellHost"
import { recordActivity } from "@/app/lib/activityLog"
import { repairOpenClawExecApprovalsFile } from "@/app/lib/sandboxPrivilegedFiles"
import { exportSandboxPolicyToFile as exportPolicy } from "@/app/lib/sandboxCreate/policy"
import {
  bucketCandidatesByAgent,
  type NemoClawAgent as NemoClawAgentT,
  type RegistryShape,
} from "@/app/lib/sandboxCreate/agentFilter"
import {
  commandExists,
  HOST_PATH,
  NEMOCLAW_BIN,
  NEMOCLAW_BIN_CANDIDATES,
  NEMOCLAW_CWD,
  NEMOCLAW_SETUP,
  NEMOCLAW_SETUP_CANDIDATES,
  NODE_BIN,
  OPENSHELL_BIN,
  hostCommandEnv,
} from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)
const DOCKER_BIN = process.env.DOCKER_BIN || "docker"
const OPENSHELL_CLUSTER_CONTAINER = process.env.OPENSHELL_CLUSTER_CONTAINER || "openshell-cluster-nemoclaw"
const OPENSHELL_NAMESPACE = process.env.OPENSHELL_SANDBOX_NAMESPACE || "openshell"
const NEMOCLAW_REGISTRY_FILE = path.join(process.env.HOME || "/tmp", ".nemoclaw", "sandboxes.json")

// Prebuilt baseline sandboxes. Produced once per VPS by manidae-cloud's install
// scripts (one `nemoclaw onboard` per agent) and left running. The existing
// `redeploy-image` blueprint flow finds them via `openshell sandbox list`, so
// the first Quick Deploy on a fresh box can clone from a baseline instead of
// waiting 12-15 min for the in-image docker build.
const BASELINE_SANDBOX_NAMES = {
  openclaw: "openclaw-baseline",
  hermes: "hermes-baseline",
} as const

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

async function recordCreateActivity(entry: Parameters<typeof recordActivity>[0]) {
  try {
    await recordActivity(entry)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? "activity log write failed")
    console.warn(`[sandbox/create] activity-log:error message=${message}`)
  }
}

type NemoClawCreateCommand = {
  file: string
  args: string[]
  mode: "cli-onboard" | "legacy-setup"
}

type CreateInferenceMode = "auto" | "vllm" | "nim"
type CreateGpuMode = "none" | "auto" | "required"
type NemoClawAgent = "openclaw" | "hermes"

type CreateInferenceSettings = {
  mode: CreateInferenceMode
  model: string
  hasApiKey: boolean
  envSummary: string[]
}

type NemoClawRegistryData = {
  sandboxes?: Record<string, { name?: string; createdAt?: string }>
  defaultSandbox?: string | null
}

function parseCreateGpuMode(body: any): CreateGpuMode {
  const raw = typeof body?.gpuMode === "string"
    ? body.gpuMode
    : process.env.OPENSHELL_CONTROL_CREATE_GPU_MODE || "none"
  return raw === "auto" || raw === "required" ? raw : "none"
}

function parseCreateInferenceSettings(body: any): CreateInferenceSettings {
  const raw = body?.createInference && typeof body.createInference === "object" ? body.createInference : {}
  const requestedMode = typeof raw.mode === "string" ? raw.mode : "vllm"
  const mode: CreateInferenceMode = requestedMode === "vllm" || requestedMode === "nim" ? requestedMode : "auto"
  const model = typeof raw.model === "string" ? raw.model.trim() : ""
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : ""

  return {
    mode,
    model,
    hasApiKey: Boolean(apiKey),
    envSummary: [],
  }
}

function applyCreateInferenceEnv(env: NodeJS.ProcessEnv, settings: CreateInferenceSettings, body: any) {
  if (settings.mode === "auto") return settings

  env.NEMOCLAW_EXPERIMENTAL = "1"
  settings.envSummary.push("NEMOCLAW_EXPERIMENTAL=1")

  if (settings.mode === "vllm") {
    env.NEMOCLAW_PROVIDER = "vllm"
    settings.envSummary.push("NEMOCLAW_PROVIDER=vllm")
  }

  if (settings.mode === "nim") {
    env.NEMOCLAW_PROVIDER = "nim-local"
    settings.envSummary.push("NEMOCLAW_PROVIDER=nim-local")
    const apiKey = typeof body?.createInference?.apiKey === "string" ? body.createInference.apiKey.trim() : ""
    if (apiKey) {
      env.NVIDIA_API_KEY = apiKey
      env.NEMOCLAW_PROVIDER_KEY = apiKey
      settings.envSummary.push("NVIDIA_API_KEY=<provided>", "NEMOCLAW_PROVIDER_KEY=<provided>")
    }
  }

  if (settings.model) {
    env.NEMOCLAW_MODEL = settings.model
    settings.envSummary.push(`NEMOCLAW_MODEL=${settings.model}`)
  }

  return settings
}

function nemoClawGpuArgs(mode: CreateGpuMode) {
  if (mode === "required") return ["--gpu"]
  if (mode === "none") return ["--no-gpu"]
  return []
}

function nemoClawAgentArgs(agent: NemoClawAgent) {
  return agent === "hermes" ? ["--agent", "hermes"] : []
}

function isNemoClawOnboardBlueprint(blueprint: string) {
  return blueprint === "nemoclaw-blueprint" || blueprint === "nemoclaw-hermes"
}

function nemoClawAgentForBlueprint(blueprint: string): NemoClawAgent {
  return blueprint === "nemoclaw-hermes" ? "hermes" : "openclaw"
}

function openShellGpuArgs(mode: CreateGpuMode) {
  return mode === "required" ? ["--gpu"] : []
}

function buildNemoClawCreateCommand(gpuMode: CreateGpuMode, agent: NemoClawAgent, sandboxName?: string): NemoClawCreateCommand {
  if (NEMOCLAW_BIN && commandExists(NEMOCLAW_BIN)) {
    // Forward the operator-supplied sandbox name to `nemoclaw onboard --name`.
    // Without this, nemoclaw silently picks its default (`my-assistant`),
    // creates a sandbox under THAT name, and the controller's subsequent
    // `openshell sandbox get <name>` polls fail forever.
    const nameArgs = sandboxName ? ["--name", sandboxName] : []
    const args = [
      "onboard",
      "--non-interactive",
      "--recreate-sandbox",
      "--yes-i-accept-third-party-software",
      ...nameArgs,
      ...nemoClawAgentArgs(agent),
      ...nemoClawGpuArgs(gpuMode),
    ]
    return /\.(?:c?m?js|ts)$/i.test(NEMOCLAW_BIN)
      ? { file: NODE_BIN, args: [NEMOCLAW_BIN, ...args], mode: "cli-onboard" }
      : { file: NEMOCLAW_BIN, args, mode: "cli-onboard" }
  }
  if (agent === "hermes") {
    throw new Error("Hermes sandbox creation requires the current NemoClaw CLI with --agent hermes support. Set NEMOCLAW_BIN in .env.local.")
  }
  if (NEMOCLAW_SETUP && commandExists(NEMOCLAW_SETUP)) {
    return { file: "/bin/bash", args: [NEMOCLAW_SETUP], mode: "legacy-setup" }
  }
  throw new Error(
    `NemoClaw CLI was not found. Install the current NemoClaw CLI under your Linux home directory, or set NEMOCLAW_BIN in .env.local. Searched CLI: ${NEMOCLAW_BIN_CANDIDATES.join(", ") || "no candidates"}. Legacy setup candidates: ${NEMOCLAW_SETUP_CANDIDATES.join(", ") || "none"}.`,
  )
}

function resolveNemoClawBasePolicyPath() {
  const home = process.env.HOME || ""
  const candidates = [
    process.env.NEMOCLAW_BASE_POLICY_PATH,
    path.join(NEMOCLAW_CWD, "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml"),
    home ? path.join(home, ".nemoclaw", "source", "nemoclaw-blueprint", "policies", "openclaw-sandbox.yaml") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate))

  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) {
    throw new Error(`NemoClaw base policy was not found. Searched: ${candidates.join(", ")}`)
  }
  return found
}

async function readPodImage(sandboxName: string, jsonpath: string) {
  const { stdout } = await execFileAsync(DOCKER_BIN, [
    "exec",
    OPENSHELL_CLUSTER_CONTAINER,
    "kubectl",
    "get",
    "pod",
    sandboxName,
    "-n",
    OPENSHELL_NAMESPACE,
    "-o",
    `jsonpath=${jsonpath}`,
  ], {
    env: hostCommandEnv(),
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  })

  return String(stdout).trim().split(/\s+/)[0] || null
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "")
}

function parseOpenShellSandboxNames(output: string) {
  return output
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trim())
    .filter(
      (entry) =>
        entry &&
        !/^name\s+/i.test(entry) &&
        !/^[\s\-=]+$/.test(entry) &&
        !/^no sandboxes found\.?$/i.test(entry)
    )
    .map((entry) => entry.split(/\s{2,}/)[0]?.trim())
    .filter((entry): entry is string => Boolean(entry))
}

function readNemoClawRegistry(): NemoClawRegistryData {
  try {
    return existsSync(NEMOCLAW_REGISTRY_FILE)
      ? JSON.parse(readFileSync(NEMOCLAW_REGISTRY_FILE, "utf8"))
      : {}
  } catch {
    return {}
  }
}

async function listOpenShellSandboxNames() {
  try {
    const { stdout } = await execFileAsync(OPENSHELL_BIN, ["sandbox", "list"], {
      env: hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      }),
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    })
    return parseOpenShellSandboxNames(String(stdout))
  } catch {
    return []
  }
}

async function getBaselineSandboxesStatus() {
  const liveNames = new Set(await listOpenShellSandboxNames())
  const agents: NemoClawAgent[] = ["openclaw", "hermes"]
  return Object.fromEntries(agents.map((agent) => {
    const name = BASELINE_SANDBOX_NAMES[agent]
    return [agent, { name, available: liveNames.has(name) }]
  })) as Record<NemoClawAgent, { name: string; available: boolean }>
}

async function resolveSourceDockerImage(sandboxName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(DOCKER_BIN, [
      "ps",
      "--filter", `name=openshell-${sandboxName}`,
      "--format", "{{.Image}}",
    ], { env: hostCommandEnv(), timeout: 10000, maxBuffer: 1024 * 1024 })
    return String(stdout).trim().split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

async function resolveSourcePodImageFromRef(sourceSandboxRef: string) {
  const requested = sourceSandboxRef.trim()
  const source = await resolveSandboxRef(requested)
  const sourceName = validateSandboxName(source.name)
  const sourceImage = await readPodImage(sourceName, '{.spec.containers[?(@.name=="agent")].image}')
    .catch(() => null)
    || await readPodImage(sourceName, "{.spec.containers[0].image}").catch(() => null)
    || await resolveSourceDockerImage(sourceName)

  if (!sourceImage) {
    throw new Error(`Could not resolve the running image for source sandbox '${sourceName}'.`)
  }

  return {
    requested,
    name: sourceName,
    id: source.id,
    image: sourceImage,
  }
}

async function resolveSourcePodImage(
  sourceSandboxRef: string | null | undefined,
  targetSandboxName: string,
  requestedAgent?: NemoClawAgent | null,
) {
  if (sourceSandboxRef && typeof sourceSandboxRef === "string" && sourceSandboxRef.trim()) {
    return await resolveSourcePodImageFromRef(sourceSandboxRef)
  }

  const registry = readNemoClawRegistry()
  const registeredEntries = Object.entries(registry.sandboxes ?? {})
    .sort(([, a], [, b]) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")))

  const agentFilter: NemoClawAgentT | null =
    requestedAgent === "hermes" || requestedAgent === "openclaw" ? requestedAgent : null
  const liveNames = await listOpenShellSandboxNames()
  const seeds = [
    registry.defaultSandbox || undefined,
    ...registeredEntries.map(([key, value]) => value?.name || key),
    ...liveNames,
  ].filter((candidate): candidate is string => Boolean(candidate && candidate !== targetSandboxName))

  const { candidates } = bucketCandidatesByAgent(seeds, registry as RegistryShape, agentFilter)

  for (const candidate of candidates) {
    try {
      return await resolveSourcePodImageFromRef(candidate)
    } catch {
      // Try the next candidate; stale registry entries are common after manual cleanup.
    }
  }

  throw new Error(
    agentFilter
      ? `No running ${agentFilter === "hermes" ? "Hermes" : "OpenClaw"} sandbox image was found for quick deploy. Create a Fresh ${agentFilter === "hermes" ? "Hermes" : "OpenClaw"} sandbox first, or pass sourceSandboxName explicitly.`
      : "No running NemoClaw sandbox image was found for quick deploy. Create one Fresh NemoClaw Image first, or pass sourceSandboxName explicitly.",
  )
}

async function exportSandboxPolicyToFile(sourceSandboxName: string): Promise<string | null> {
  return exportPolicy(
    sourceSandboxName,
    OPENSHELL_BIN,
    hostCommandEnv({ OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw" }),
  )
}

function registerNemoClawImageRedeploy(sourceName: string, sandboxName: string) {
  try {
    const current = existsSync(NEMOCLAW_REGISTRY_FILE)
      ? JSON.parse(readFileSync(NEMOCLAW_REGISTRY_FILE, "utf8"))
      : {}
    const sandboxes = current && typeof current.sandboxes === "object" && current.sandboxes !== null
      ? current.sandboxes
      : {}
    const sourceEntry = sandboxes[sourceName] && typeof sandboxes[sourceName] === "object"
      ? sandboxes[sourceName]
      : { name: sourceName }

    sandboxes[sandboxName] = {
      ...sourceEntry,
      name: sandboxName,
      createdAt: new Date().toISOString(),
      nimContainer: null,
      policies: [],
      imageTag: null,
    }

    const next = {
      ...current,
      sandboxes,
      defaultSandbox: current.defaultSandbox || sandboxName,
    }
    mkdirSync(path.dirname(NEMOCLAW_REGISTRY_FILE), { recursive: true })
    const tempPath = `${NEMOCLAW_REGISTRY_FILE}.tmp.${process.pid}.${Date.now()}`
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(tempPath, NEMOCLAW_REGISTRY_FILE)
    return {
      ok: true as const,
      registryFile: NEMOCLAW_REGISTRY_FILE,
      note: "Registered the image-redeployed sandbox in the local NemoClaw registry without assigning a host Docker image tag.",
    }
  } catch (error) {
    return {
      ok: false as const,
      registryFile: NEMOCLAW_REGISTRY_FILE,
      error: error instanceof Error ? error.message : "Failed to update the local NemoClaw registry",
    }
  }
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

async function runCommand(file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const startedAt = Date.now()
  console.log(`[sandbox/create] command:start file=${file} args=${JSON.stringify(args)}`)
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
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

async function runCreateCommandUntilReady(file: string, args: string[], env: NodeJS.ProcessEnv, sandboxName: string, timeoutMs: number, intervalMs: number, cwd?: string) {
  const startedAt = Date.now()
  console.log(`[sandbox/create] ready-command:start file=${file} args=${JSON.stringify(args)} timeoutMs=${timeoutMs}`)

  return await new Promise<{
    completed: boolean
    timedOut: boolean
    forcedReady: boolean
    readyVerification?: SandboxVerification
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    error?: string
  }>((resolve) => {
    const child = spawn(file, args, {
      env,
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    let checkingReady = false

    const finish = (result: {
      completed: boolean
      timedOut: boolean
      forcedReady: boolean
      readyVerification?: SandboxVerification
      exitCode: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
      error?: string
    }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(readinessTimer)
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
      console.log(`[sandbox/create] ready-command:error file=${file} elapsedMs=${elapsedMs(startedAt)} message=${message}`)
      finish({
        completed: false,
        timedOut: false,
        forcedReady: false,
        exitCode: null,
        signal: null,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        error: message,
      })
    })

    child.on("close", (code, signal) => {
      console.log(`[sandbox/create] ready-command:close file=${file} elapsedMs=${elapsedMs(startedAt)} code=${code} signal=${signal} stdoutBytes=${stdout.length} stderrBytes=${stderr.length}`)
      finish({
        completed: true,
        timedOut: false,
        forcedReady: false,
        exitCode: code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ...(code === 0 ? {} : { error: `Command exited with code ${code}${signal ? ` signal ${signal}` : ""}` }),
      })
    })

    const readinessTimer = setInterval(() => {
      if (settled || checkingReady) return
      checkingReady = true
      verifySandboxCreation(sandboxName)
        .then((verification) => {
          if (!settled && verification.verified) {
            console.log(`[sandbox/create] ready-command:ready sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)} sending=SIGTERM`)
            child.kill("SIGTERM")
            finish({
              completed: false,
              timedOut: false,
              forcedReady: true,
              readyVerification: verification,
              exitCode: null,
              signal: "SIGTERM",
              stdout: stdout.trim(),
              stderr: stderr.trim(),
            })
          }
        })
        .finally(() => {
          checkingReady = false
        })
    }, intervalMs)

    const timer = setTimeout(() => {
      console.log(`[sandbox/create] ready-command:timeout file=${file} elapsedMs=${elapsedMs(startedAt)} sending=SIGTERM`)
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!settled) {
          console.log(`[sandbox/create] ready-command:timeout-escalate file=${file} elapsedMs=${elapsedMs(startedAt)} sending=SIGKILL`)
          child.kill("SIGKILL")
        }
      }, 2000)
      finish({
        completed: false,
        timedOut: true,
        forcedReady: false,
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
  ], hostCommandEnv({
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
  }), 15000)

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

async function ensureOpenClawGatewayToken(sandboxName: string) {
  const script = [
    "openclaw doctor --generate-gateway-token >/dev/null 2>&1 || true",
    'token=$(node -e \'const fs=require("fs"); try { const c=JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json","utf8")); process.stdout.write(String(c?.gateway?.auth?.token||c?.gateway?.token||"")); } catch(e) {}\')',
    'printf "%s" "$token"',
  ].join("; ")

  const result = await runCreateCommandBounded(OPENSHELL_BIN, [
    "sandbox",
    "exec",
    "-n",
    sandboxName,
    "--",
    "sh",
    "-lc",
    script,
  ], hostCommandEnv({
    OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
  }), 60000)

  const token = (result.stdout || "").trim()
  const tokenPresent = Boolean(token) && !/\s/.test(token)

  return {
    attempted: true,
    tokenPresent,
    completed: result.completed,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    signal: result.signal,
    error: result.error,
    note: tokenPresent
      ? "Ensured OpenClaw gateway auth token in /sandbox/.openclaw/openclaw.json so the dashboard proxy can authenticate."
      : "Tried to generate OpenClaw gateway auth token but the sandbox config still has no token; dashboard proxy will fail until this is fixed.",
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
  const baselineStatus = await getBaselineSandboxesStatus()
  return NextResponse.json({
    ok: true,
    baselineSandboxes: baselineStatus,
    blueprints: [
      {
        id: "nemoclaw-blueprint",
        label: "Fresh NemoClaw Image",
        description: "Bootstraps a full NemoClaw sandbox using the nemoclaw-blueprint workflow.",
        type: "blueprint",
        source: "~/NemoClaw/nemoclaw-blueprint/blueprint.yaml",
        supportsTailscale: true,
        baseline: baselineStatus.openclaw,
      },
      {
        id: "nemoclaw-hermes",
        label: "Fresh Hermes Sandbox",
        description: "Bootstraps a Hermes Agent sandbox using NemoClaw's Hermes workflow.",
        type: "blueprint",
        source: "~/NemoClaw/agents/hermes/Dockerfile",
        supportsTailscale: false,
        baseline: baselineStatus.hermes,
      },
      {
        id: "custom-sandbox",
        label: "New Custom Sandbox",
        description: "Create a generic OpenShell sandbox with a custom policy path.",
        type: "custom",
        source: "dashboard-custom",
        supportsTailscale: false,
      },
      {
        id: "redeploy-image",
        label: "Quick Deploy New NemoClaw Sandbox",
        description: "Create a default NemoClaw sandbox from the latest available running image without rebuilding it.",
        type: "image",
        source: "default-running-image",
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
    const gpuMode = parseCreateGpuMode(body)
    const createInference = parseCreateInferenceSettings(body)
    console.log(`[sandbox/create] request:parsed sandbox=${sandboxName} blueprint=${blueprint} enableTailscale=${enableTailscale} gpuMode=${gpuMode} inferenceMode=${createInference.mode} elapsedMs=${elapsedMs(requestStartedAt)}`)

    if (!blueprint) {
      return NextResponse.json({ ok: false, error: "blueprint is required" }, { status: 400 })
    }

    await recordCreateActivity({
      type: "sandbox.create.start",
      status: "info",
      sandboxName,
      message: `Sandbox creation started for ${sandboxName} using ${blueprint}.`,
      metadata: { blueprint, gpuMode, inferenceMode: createInference.mode },
    })

    if (isNemoClawOnboardBlueprint(blueprint)) {
      const agent = nemoClawAgentForBlueprint(blueprint)
      const isOpenClawAgent = agent === "openclaw"
      const createCommand = buildNemoClawCreateCommand(gpuMode, agent, sandboxName)
      const env: NodeJS.ProcessEnv = hostCommandEnv({
        NEMOCLAW_SANDBOX_NAME: sandboxName,
        NEMOCLAW_AGENT: agent,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_RECREATE_SANDBOX: "1",
        NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      })

      // When Ollama is configured, route NemoClaw to the local Ollama provider
      // so it never falls back to NVIDIA NIM even if NEMOCLAW_PROVIDER was
      // omitted from .env.local.
      if (process.env.OLLAMA_BASE_URL && !env.NEMOCLAW_PROVIDER) {
        env.NEMOCLAW_PROVIDER = "ollama"
        if (process.env.OLLAMA_MODEL && !env.NEMOCLAW_MODEL) {
          env.NEMOCLAW_MODEL = process.env.OLLAMA_MODEL
        }
      }

      if (!enableTailscale) {
        env.NVIDIA_API_KEY = env.NVIDIA_API_KEY || "optional-local-mode"
      }

      applyCreateInferenceEnv(env, createInference, body)

      // OpenClaw: SIGTERM as soon as the sandbox is Ready — this skips nemoclaw's step 8/8
      // policy application which reliably times out and exits 1 even on success.
      // Hermes: must run to completion. The agent_setup step (after sandbox-ready) is where
      // nemoclaw configures the Hermes API server inside the sandbox; killing early leaves
      // Hermes half-installed and unregistered. The fallback below still tolerates a
      // non-zero exit if the sandbox itself comes up Ready.
      const createCommandArgs = createCommand.mode === "legacy-setup"
        ? [...createCommand.args, sandboxName]
        : createCommand.args
      // First-time NemoClaw image builds are slow — the in-image docker build is
      // 80+ steps including a full NPM install and OpenClaw npm install/build.
      // On under-provisioned VPSs (4 vCPU / 8 GiB, no swap) this routinely
      // takes 12-15 minutes. The previous 10 / 15 min ceilings caused our
      // bounded command to SIGTERM the onboard mid-build, leaving the sandbox
      // in a half-baked state. Bump both paths to 20 minutes. Subsequent
      // builds reuse the cached layers and finish in ~30 seconds — the cap
      // only matters for the very first sandbox on a fresh box.
      const FIRST_BUILD_TIMEOUT_MS = 20 * 60 * 1000
      const result = agent === "hermes"
        ? await runCreateCommandBounded(createCommand.file, createCommandArgs, env, FIRST_BUILD_TIMEOUT_MS)
        : await runCreateCommandUntilReady(
            createCommand.file,
            createCommandArgs,
            env,
            sandboxName,
            FIRST_BUILD_TIMEOUT_MS,
            5000,
            NEMOCLAW_CWD,
          )

      // If the command exited non-zero before the sandbox was detected as Ready, do one
      // final readiness poll before giving up — the sandbox may have just beaten the interval.
      const readiness = await waitForSandboxReady(sandboxName, 90000, 2000)
      const verification = readiness.verification ?? {
        verified: false,
        summary: "Sandbox readiness polling produced no verification result.",
        error: "Sandbox readiness polling produced no verification result.",
      }
      const created = readiness.verified

      if (!created && result.error && !result.timedOut) {
        await recordCreateActivity({
          type: "sandbox.create.error",
          status: "error",
          sandboxName,
          message: `Sandbox creation command failed for ${sandboxName}.`,
          metadata: { blueprint, agent, gpuMode, inferenceMode: createInference.mode, elapsedMs: elapsedMs(requestStartedAt), error: result.error },
        })
        return NextResponse.json({
          ok: false,
          error: result.error,
          stdout: result.stdout,
          stderr: result.stderr,
          blueprint,
          agent,
          sandboxName,
          enableTailscale,
          gpuMode,
          createInference,
        }, { status: 500 })
      }

      const execApprovalsRepair = created && isOpenClawAgent ? await repairOpenClawExecApprovalsFile(sandboxName).catch((error) => ({
        sandboxName,
        path: "/sandbox/.openclaw/exec-approvals.json",
        error: error instanceof Error ? error.message : "Failed to repair OpenClaw exec approvals file",
      })) : null
      const deviceApproval = created && isOpenClawAgent ? await approveOpenClawDeviceRequests(sandboxName) : null
      const gatewayToken = created && isOpenClawAgent ? await ensureOpenClawGatewayToken(sandboxName).catch((error) => ({
        attempted: true,
        tokenPresent: false,
        completed: false,
        timedOut: false,
        exitCode: null as number | null,
        signal: null as string | null,
        error: error instanceof Error ? error.message : "Failed to ensure OpenClaw gateway auth token.",
        note: "Failed to ensure OpenClaw gateway auth token; dashboard proxy will fail until this is fixed.",
      })) : null
      // Pre-build the Hermes dashboard web UI dependencies on sandbox creation.
      const hermesDashboardBuild = created && agent === "hermes"
        ? await prebuildHermesDashboardWebUi(sandboxName).catch((error) => ({
            built: false,
            skipped: false,
            error: error instanceof Error ? error.message : "Hermes dashboard web UI pre-build failed",
          }))
        : null
      const forcedReady = "forcedReady" in result ? result.forcedReady : false
      console.log(
        `[sandbox/create] request:complete sandbox=${sandboxName} created=${created} agent=${agent} forcedReady=${forcedReady} readinessAttempts=${readiness.attempts} deviceApproval=${deviceApproval?.approved ?? false} elapsedMs=${elapsedMs(requestStartedAt)}`,
      )
      await recordCreateActivity({
        type: created ? "sandbox.create.success" : "sandbox.create.warning",
        status: created ? "success" : "warning",
        sandboxId: verification.details?.id || undefined,
        sandboxName,
        message: created
          ? `Sandbox ${sandboxName} is ready after ${readiness.attempts} readiness checks.`
          : `Sandbox creation command finished for ${sandboxName}, but readiness was not verified.`,
        metadata: { blueprint, agent, gpuMode, inferenceMode: createInference.mode, readinessAttempts: readiness.attempts, elapsedMs: elapsedMs(requestStartedAt) },
      })

      return NextResponse.json({
        ok: created,
        blueprint,
        agent,
        sandboxName,
        created,
        verified: verification.verified,
        verification,
        mode: blueprint,
        enableTailscale,
        gpuMode,
        createInference,
        createCommand: {
          ...createCommand,
          forcedReady,
          timedOut: result.timedOut,
          exitCode: result.exitCode,
          signal: result.signal,
        },
        hostPath: HOST_PATH,
        readiness: {
          attempts: readiness.attempts,
          elapsedMs: readiness.elapsedMs,
        },
        execApprovalsRepair,
        deviceApproval,
        gatewayToken,
        hermesDashboardBuild,
        stdout: result.stdout,
        stderr: result.stderr,
        note: created
          ? appendNote(
              agent === "hermes"
                ? "NemoClaw Hermes workflow completed. Hermes exposes an API endpoint from the sandbox rather than an OpenClaw browser dashboard."
                : forcedReady
                  ? "NemoClaw blueprint workflow: sandbox reached Ready state and the onboard command was stopped early."
                  : enableTailscale
                    ? "NemoClaw blueprint workflow completed with Tailscale-enabled prerequisites. Existing healthy OpenShell gateways are reused before any new gateway start is attempted."
                    : "NemoClaw blueprint workflow completed in local/default mode. Existing healthy OpenShell gateways are reused before any new gateway start is attempted.",
              gpuMode === "none"
                ? "GPU passthrough was disabled for this create run."
                : gpuMode === "required"
                  ? "GPU passthrough was required for this create run."
                  : "NemoClaw chose GPU passthrough automatically for this create run.",
              execApprovalsRepair && "note" in execApprovalsRepair ? execApprovalsRepair.note : false,
              execApprovalsRepair && "error" in execApprovalsRepair ? `OpenClaw exec approvals repair failed: ${execApprovalsRepair.error}` : false,
              deviceApproval?.note,
            )
          : "Blueprint command reported success, but the sandbox never reached a ready verification state afterward.",
      }, { status: created ? 200 : 502 })
    }

    if (blueprint === "custom-sandbox") {
      const env: NodeJS.ProcessEnv = hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
        NO_COLOR: "1",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      })
      const createAttempt = await runCreateCommandBounded(OPENSHELL_BIN, ["sandbox", "create", "--name", sandboxName, ...openShellGpuArgs(gpuMode)], env, 15000)

      if (createAttempt.completed && createAttempt.exitCode !== 0) {
        await recordCreateActivity({
          type: "sandbox.create.error",
          status: "error",
          sandboxName,
          message: `Custom sandbox creation command failed for ${sandboxName}.`,
          metadata: { blueprint, gpuMode, elapsedMs: elapsedMs(requestStartedAt), error: createAttempt.error, exitCode: createAttempt.exitCode },
        })
        return NextResponse.json({
          ok: false,
          error: createAttempt.error ?? `create command failed with exit code ${createAttempt.exitCode}`,
          stdout: createAttempt.stdout,
          stderr: createAttempt.stderr,
          blueprint,
          sandboxName,
          gpuMode,
        }, { status: 500 })
      }

      const readiness = await waitForSandboxReady(sandboxName, 90000, 2000)
      const verification = readiness.verification ?? {
        verified: false,
        summary: "Sandbox readiness polling produced no verification result.",
        error: "Sandbox readiness polling produced no verification result.",
      }
      const created = readiness.verified
      const execApprovalsRepair = created ? await repairOpenClawExecApprovalsFile(sandboxName).catch((error) => ({
        sandboxName,
        path: "/sandbox/.openclaw/exec-approvals.json",
        error: error instanceof Error ? error.message : "Failed to repair OpenClaw exec approvals file",
      })) : null
      const deviceApproval = created ? await approveOpenClawDeviceRequests(sandboxName) : null
      const gatewayToken = created ? await ensureOpenClawGatewayToken(sandboxName).catch(() => null) : null
      const policyPrepared = Boolean(policy)
      console.log(
        `[sandbox/create] request:complete sandbox=${sandboxName} created=${created} createTimedOut=${createAttempt.timedOut} readinessAttempts=${readiness.attempts} deviceApproval=${deviceApproval?.approved ?? false} gatewayTokenPresent=${gatewayToken?.tokenPresent ?? false} elapsedMs=${elapsedMs(requestStartedAt)}`,
      )
      await recordCreateActivity({
        type: created ? "sandbox.create.success" : "sandbox.create.warning",
        status: created ? "success" : "warning",
        sandboxId: verification.details?.id || undefined,
        sandboxName,
        message: created
          ? `Custom sandbox ${sandboxName} is ready after ${readiness.attempts} readiness checks.`
          : `Custom sandbox creation finished for ${sandboxName}, but readiness was not verified.`,
        metadata: { blueprint, gpuMode, readinessAttempts: readiness.attempts, elapsedMs: elapsedMs(requestStartedAt), createTimedOut: createAttempt.timedOut },
      })
      return NextResponse.json({
        ok: created,
        blueprint,
        sandboxName,
        created,
        verified: verification.verified,
        verification,
        mode: "custom-sandbox",
        gpuMode,
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
        execApprovalsRepair,
        deviceApproval,
        gatewayToken,
        policyPrepared,
        note: created
          ? appendNote(
              createAttempt.timedOut
                ? "Custom sandbox reached Ready even though the create CLI did not exit promptly."
                : (policyPrepared
                    ? "Custom sandbox created. Policy draft is prepared, but applying it live should be a follow-up action."
                    : "Custom sandbox created."),
              gpuMode === "required"
                ? "GPU passthrough was requested for this create run."
                : false,
              execApprovalsRepair && "note" in execApprovalsRepair ? execApprovalsRepair.note : false,
              execApprovalsRepair && "error" in execApprovalsRepair ? `OpenClaw exec approvals repair failed: ${execApprovalsRepair.error}` : false,
              deviceApproval?.note,
            )
          : "Create command started, but the sandbox never reached a ready verification state afterward.",
      }, { status: created ? 200 : 502 })
    }

    if (blueprint === "redeploy-image") {
      const sourceSandboxName = typeof body?.sourceSandboxName === "string" ? body.sourceSandboxName.trim() : ""
      const requestedAgentRaw = typeof body?.agent === "string" ? body.agent.trim().toLowerCase() : ""
      const requestedAgent: NemoClawAgent | null = requestedAgentRaw === "hermes" ? "hermes" : requestedAgentRaw === "openclaw" ? "openclaw" : null
      const source = await resolveSourcePodImage(sourceSandboxName, sandboxName, requestedAgent)
      const sourceImage = source.image
      // Inherit the source's effective policy. Hermes sandboxes need /opt/hermes
      // in the read_only set (which the static openclaw-sandbox.yaml template
      // lacks); without this, Landlock denies execute on the hermes binary in
      // the redeployed sandbox. Fall back to the static policy if export fails.
      const inheritedPolicyPath = await exportSandboxPolicyToFile(source.name)
      const basePolicyPath = inheritedPolicyPath ?? resolveNemoClawBasePolicyPath()
      const policySource: "source-sandbox" | "base-template" = inheritedPolicyPath ? "source-sandbox" : "base-template"
      const env: NodeJS.ProcessEnv = hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      })

      const createAttempt = await runCreateCommandUntilReady(OPENSHELL_BIN, [
        "sandbox",
        "create",
        "--name",
        sandboxName,
        ...openShellGpuArgs(gpuMode),
        "--from",
        sourceImage,
        "--policy",
        basePolicyPath,
        "--auto-providers",
        "--",
        "nemoclaw-start",
      ], env, sandboxName, 120000, 2000)

      const readiness = createAttempt.readyVerification?.verified
        ? {
            verified: true as const,
            verification: createAttempt.readyVerification,
            attempts: 0,
            elapsedMs: 0,
          }
        : await waitForSandboxReady(sandboxName, 90000, 2000)
      const verification = readiness.verification ?? {
        verified: false,
        summary: "Sandbox readiness polling produced no verification result.",
        error: "Sandbox readiness polling produced no verification result.",
      }
      const created = readiness.verified
      const registry = created ? registerNemoClawImageRedeploy(source.name, sandboxName) : null
      const sourceAgent: NemoClawAgent = (() => {
        const map = readNemoClawRegistry().sandboxes ?? {}
        const entry = (map[source.name] ?? map[source.id ?? ""]) as { agent?: string } | undefined
        const value = typeof entry?.agent === "string" ? entry.agent.trim() : ""
        return value === "hermes" ? "hermes" : "openclaw"
      })()
      const effectiveAgent: NemoClawAgent = requestedAgent ?? sourceAgent
      const isOpenClawAgent = effectiveAgent === "openclaw"
      const execApprovalsRepair = created && isOpenClawAgent ? await repairOpenClawExecApprovalsFile(sandboxName).catch((error) => ({
        sandboxName,
        path: "/sandbox/.openclaw/exec-approvals.json",
        error: error instanceof Error ? error.message : "Failed to repair OpenClaw exec approvals file",
      })) : null
      const deviceApproval = created && isOpenClawAgent ? await approveOpenClawDeviceRequests(sandboxName) : null
      const gatewayToken = created && isOpenClawAgent ? await ensureOpenClawGatewayToken(sandboxName).catch(() => null) : null
      console.log(
        `[sandbox/create] request:complete sandbox=${sandboxName} created=${created} mode=redeploy-image agent=${effectiveAgent} policySource=${policySource} createTimedOut=${createAttempt.timedOut} readinessAttempts=${readiness.attempts} deviceApproval=${deviceApproval?.approved ?? false} gatewayTokenPresent=${gatewayToken?.tokenPresent ?? false} elapsedMs=${elapsedMs(requestStartedAt)}`,
      )

      const createFailed = createAttempt.completed && createAttempt.exitCode !== 0 && !created
      await recordCreateActivity({
        type: created ? "sandbox.create.success" : createFailed ? "sandbox.create.error" : "sandbox.create.warning",
        status: created ? "success" : createFailed ? "error" : "warning",
        sandboxId: verification.details?.id || undefined,
        sandboxName,
        message: created
          ? `Quick deploy sandbox ${sandboxName} is ready after ${readiness.attempts} readiness checks.`
          : createFailed
            ? `Quick deploy command failed for ${sandboxName}.`
            : `Quick deploy started for ${sandboxName}, but readiness was not verified.`,
        metadata: { blueprint, gpuMode, sourceSandboxName: source.name, readinessAttempts: readiness.attempts, elapsedMs: elapsedMs(requestStartedAt), createTimedOut: createAttempt.timedOut, forcedReady: createAttempt.forcedReady, error: createAttempt.error },
      })
      return NextResponse.json({
        ok: created,
        blueprint,
        sandboxName,
        sourceSandboxName: source.name,
        sourceSandboxId: source.id,
        sourceImage,
        basePolicyPath,
        policySource,
        agent: effectiveAgent,
        created,
        verified: verification.verified,
        verification,
        mode: "redeploy-image",
        gpuMode,
        stdout: createAttempt.stdout,
        stderr: createAttempt.stderr,
        createCommand: {
          completed: createAttempt.completed,
          timedOut: createAttempt.timedOut,
          forcedReady: createAttempt.forcedReady,
          exitCode: createAttempt.exitCode,
          signal: createAttempt.signal,
          error: createAttempt.error,
        },
        readiness: {
          attempts: readiness.attempts,
          elapsedMs: readiness.elapsedMs,
        },
        registry,
        execApprovalsRepair,
        deviceApproval,
        gatewayToken,
        note: created
          ? appendNote(
              `Sandbox created by redeploying the running image from '${source.name}' instead of rebuilding it.`,
              gpuMode === "required"
                ? "GPU passthrough was requested for this create run."
                : false,
              createAttempt.forcedReady
                ? "The dashboard returned as soon as OpenShell reported the redeployed sandbox Ready."
                : false,
              createAttempt.timedOut
                ? "The OpenShell create command stayed attached after the sandbox reached Ready, so the dashboard stopped waiting for the local command."
                : false,
              registry && !registry.ok ? `NemoClaw registry update failed: ${registry.error}` : false,
              execApprovalsRepair && "note" in execApprovalsRepair ? execApprovalsRepair.note : false,
              execApprovalsRepair && "error" in execApprovalsRepair ? `OpenClaw exec approvals repair failed: ${execApprovalsRepair.error}` : false,
              deviceApproval?.note,
            )
          : createFailed
            ? "Image redeploy command failed and the sandbox never reached a ready verification state afterward."
            : "Image redeploy started, but the sandbox never reached a ready verification state afterward.",
      }, { status: created ? 200 : createFailed ? 500 : 502 })
    }

    await recordCreateActivity({
      type: "sandbox.create.error",
      status: "error",
      sandboxName,
      message: `Sandbox creation failed for ${sandboxName}: unknown blueprint ${blueprint}.`,
      metadata: { blueprint, gpuMode, elapsedMs: elapsedMs(requestStartedAt) },
    })
    return NextResponse.json({ ok: false, error: `unknown blueprint: ${blueprint}` }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox creation failed"
    await recordCreateActivity({
      type: "sandbox.create.error",
      status: "error",
      message: `Sandbox creation failed: ${message}`,
      metadata: { elapsedMs: elapsedMs(requestStartedAt) },
    })
    const status = /required|must be|too long|unknown blueprint/.test(message) ? 400 : 500
    console.log(`[sandbox/create] request:error elapsedMs=${elapsedMs(requestStartedAt)} message=${message}`)
    return NextResponse.json({ ok: false, error: message }, { status })
  }
}
