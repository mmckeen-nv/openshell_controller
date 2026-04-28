import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { hostname, networkInterfaces } from "node:os"
import { promisify } from "node:util"
import { HOST_PATH, NEMOCLAW_BIN, NODE_BIN, OPENSHELL_BIN, hostCommandEnv } from "@/app/lib/hostCommands"
import { resolveRuntimeAuthority } from "@/app/lib/runtimeAuthority"

const execFileAsync = promisify(execFile)

type SandboxSummary = {
  id: string
  name: string
  namespace: string
  status: string
  sshHostAlias: string
  hasSshConfig: boolean
  source: "openshell"
  isDefault: boolean
}

type NemoClawSummary = {
  available: boolean
  defaultSandboxNames: string[]
  serviceLines: string[]
  summaryLines: string[]
  source: "nemoclaw-cli" | "none"
}

type SandboxItem = {
  metadata: {
    name: string
    namespace: string
    labels: Record<string, string>
  }
  spec: {
    template: {
      image: string | null
    }
  }
  status: {
    phase: string
    podIP: string | null
    conditions: Array<{
      type: string
      status: string
    }>
  }
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "")
}

function parseField(output: string, label: string) {
  const normalizedLabel = label.toLowerCase()
  const line = output
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trim())
    .find((entry) => entry.toLowerCase().startsWith(`${normalizedLabel}:`))

  return line ? line.slice(label.length + 1).trim() : null
}

function parseSshHostAlias(sshConfig: string, fallbackName: string) {
  const hostLine = sshConfig
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith("host "))

  const alias = hostLine
    ?.split(/\s+/)
    .slice(1)
    .find((entry) => entry !== "*")

  return alias || `openshell-${fallbackName}`
}

function normalizePhase(phase: string | null) {
  const value = (phase ?? "Unknown").toLowerCase()

  switch (value) {
    case "ready":
      return "Running"
    case "provisioning":
      return "Pending"
    case "deleting":
      return "Stopping"
    case "error":
      return "Error"
    default:
      return phase ?? "Unknown"
  }
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

function parseDefaultSandboxNames(output: string) {
  return new Set(
    output
      .split(/\r?\n/)
      .map((entry) => stripAnsi(entry))
      .filter((entry) => /^\s{2,}[\w.-]+(?:\s+\*)?\s*$/.test(entry) && entry.includes("*"))
      .map((entry) => entry.replace("*", "").trim())
      .filter(Boolean)
  )
}

function buildNemoClawSummary(output: string | null, defaultSandboxNames: Set<string>): NemoClawSummary {
  if (!output) {
    return {
      available: false,
      defaultSandboxNames: [],
      serviceLines: [],
      summaryLines: [],
      source: "none",
    }
  }

  const lines = output
    .split(/\r?\n/)
    .map((entry) => stripAnsi(entry).trim())
    .filter(Boolean)

  const serviceLines = lines.filter((entry) => /\((running|stopped|failed|error|unknown)\)/i.test(entry))

  return {
    available: true,
    defaultSandboxNames: Array.from(defaultSandboxNames),
    serviceLines,
    summaryLines: lines.slice(0, 20),
    source: "nemoclaw-cli",
  }
}

async function execNemoclaw(args: string[]) {
  const env = {
    ...process.env,
    PATH: HOST_PATH,
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
  }

  const command = /\.(?:c?m?js|ts)$/i.test(NEMOCLAW_BIN)
    ? execFileAsync(NODE_BIN, [NEMOCLAW_BIN, ...args], { env })
    : execFileAsync(NEMOCLAW_BIN, args, { env })

  const { stdout, stderr } = await command
  return { stdout, stderr }
}

async function execOpenShell(args: string[]) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv(),
  })

  return { stdout, stderr }
}


function readHostIdentity() {
  const interfaces = networkInterfaces()
  const preferred = ["en0", "en1", "bridge0", "lo0"]

  for (const name of preferred) {
    const entries = interfaces[name] ?? []
    const match = entries.find((entry) => entry.family === "IPv4" && !entry.internal)
    if (match?.address) {
      return { hostname: hostname(), address: match.address, interface: name }
    }
  }

  for (const [name, entries] of Object.entries(interfaces)) {
    const match = (entries ?? []).find((entry) => entry.family === "IPv4" && !entry.internal)
    if (match?.address) {
      return { hostname: hostname(), address: match.address, interface: name }
    }
  }

  return { hostname: hostname(), address: "127.0.0.1", interface: "lo0" }
}

async function readSandbox(name: string, defaultSandboxNames: Set<string>): Promise<{ summary: SandboxSummary; pod: SandboxItem }> {
  try {
    const [{ stdout: detailsStdout }, { stdout: sshStdout }] = await Promise.all([
      execOpenShell(["sandbox", "get", name]),
      execOpenShell(["sandbox", "ssh-config", name]),
    ])

    const sandboxName = parseField(detailsStdout, "Name") ?? name
    const namespace = parseField(detailsStdout, "Namespace") ?? "openshell"
    const phase = normalizePhase(parseField(detailsStdout, "Phase"))
    const sandboxId = parseField(detailsStdout, "Id") ?? sandboxName
    const sshConfig = sshStdout.trim()
    const sshHostAlias = parseSshHostAlias(sshConfig, sandboxName)
    const isDefault = defaultSandboxNames.has(sandboxName)

    return {
      summary: {
        id: sandboxId,
        name: sandboxName,
        namespace,
        status: phase,
        sshHostAlias,
        hasSshConfig: Boolean(sshConfig),
        source: "openshell",
        isDefault,
      },
      pod: {
        metadata: {
          name: sandboxName,
          namespace,
          labels: {
            "nemoclaw.ai/sandbox-name": sandboxName,
            ...(sandboxId ? { "nemoclaw.ai/sandbox-id": sandboxId } : {}),
            ...(isDefault ? { "nemoclaw.ai/default": "true" } : {}),
          },
        },
        spec: {
          template: {
            image: null,
          },
        },
        status: {
          phase,
          podIP: sshHostAlias,
          conditions: [
            {
              type: "Ready",
              status: phase === "Running" ? "True" : "False",
            },
          ],
        },
      },
    }
  } catch (error) {
    const sandboxName = name
    const isDefault = defaultSandboxNames.has(sandboxName)
    return {
      summary: {
        id: sandboxName,
        name: sandboxName,
        namespace: "openshell",
        status: "Unknown",
        sshHostAlias: `openshell-${sandboxName}`,
        hasSshConfig: false,
        source: "openshell",
        isDefault,
      },
      pod: {
        metadata: {
          name: sandboxName,
          namespace: "openshell",
          labels: {
            "nemoclaw.ai/sandbox-name": sandboxName,
            "nemoclaw.ai/sandbox-id": sandboxName,
            ...(isDefault ? { "nemoclaw.ai/default": "true" } : {}),
          },
        },
        spec: {
          template: {
            image: null,
          },
        },
        status: {
          phase: "Unknown",
          podIP: `openshell-${sandboxName}`,
          conditions: [
            {
              type: "Ready",
              status: "False",
            },
          ],
        },
      },
    }
  }
}

export async function GET() {
  try {
    const { stdout: sandboxListStdout } = await execOpenShell(["sandbox", "list"])
    const names = parseOpenShellSandboxNames(sandboxListStdout)
    const [nemoclawListResult, nemoclawStatusResult] = names.length > 0
      ? await Promise.all([
          execNemoclaw(["list"]).catch(() => null),
          execNemoclaw(["status"]).catch(() => null),
        ])
      : [null, null]
    const defaultSandboxNames = parseDefaultSandboxNames(nemoclawListResult?.stdout ?? "")
    const results = await Promise.all(names.map((name) => readSandbox(name, defaultSandboxNames)))
    const sandboxes = results.map((result) => result.summary)
    const items = results.map((result) => result.pod)
    const nemoclaw = buildNemoClawSummary(nemoclawStatusResult?.stdout ?? null, defaultSandboxNames)

    const authorities = sandboxes.map((sandbox) => ({
      sandboxId: sandbox.id,
      ...resolveRuntimeAuthority({ sandboxId: sandbox.id }),
    }))

    const inventoryCount = sandboxes.length
    const hasMappedFallbackWithoutInventory = inventoryCount === 0

    return NextResponse.json({
      sandboxes,
      pods: { items },
      nemoclaw,
      host: readHostIdentity(),
      source: "openshell-cli",
      authoritySource: "runtimeAuthority",
      truthState: hasMappedFallbackWithoutInventory ? "unverified" : "verified",
      degraded: hasMappedFallbackWithoutInventory,
      inventoryCount,
      authorities: authorities.map((authority) => ({
        sandboxId: authority.sandboxId,
        requestedSandboxId: authority.requestedSandboxId,
        resolvedSandboxId: authority.resolvedSandboxId,
        sandboxAuthority: authority.sandboxAuthority,
        instanceId: authority.openclaw.id,
        sandboxInstanceId: authority.mappedSandboxInstanceId,
        explicitInstanceOverride: authority.explicitInstanceOverride,
        usedMappedSandboxInstance: authority.usedMappedSandboxInstance,
      })),
      defaultSource: defaultSandboxNames.size > 0 ? "nemoclaw-cli" : "none",
      count: inventoryCount,
      message: hasMappedFallbackWithoutInventory
        ? "Fetched live OpenShell inventory: zero sandboxes reported, so any mapped NemoClaw dashboard should be treated as fallback-only."
        : "Fetched live sandbox inventory from the clean OpenShell runtime",
    })
  } catch (error) {
    console.error("Error fetching real telemetry:", error)

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to fetch live OpenShell sandbox inventory",
      },
      { status: 500 }
    )
  }
}
