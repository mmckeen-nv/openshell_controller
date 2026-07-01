import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { resolveSandboxRef } from "@/app/lib/openshellHost"
import { OPENSHELL_BIN, hostCommandEnv } from "@/app/lib/hostCommands"
import { readHermesRemoteAccess, unexposeHermesRemote } from "@/app/lib/hermesRemote"

const execFileAsync = promisify(execFile)

const PERSISTENT_STATE_TARGETS: Record<string, { dir: string; targets: string[] }> = {
  openclaw: {
    dir: "/sandbox/.openclaw",
    targets: [
      "agents",
      "extensions",
      "workspace",
      "skills",
      "hooks",
      "identity",
      "devices",
      "canvas",
      "cron",
      "memory",
      "telegram",
      "wechat",
      "whatsapp",
      "credentials",
      "openclaw.json",
      "workspace-*",
    ],
  },
  hermes: {
    dir: "/sandbox/.hermes",
    targets: [
      "memories",
      "sessions",
      "skills",
      "plugins",
      "cron",
      "logs",
      "skins",
      "plans",
      "workspace",
      "profiles",
      "cache",
      "pairing",
      "platforms",
      "weixin",
      "SOUL.md",
      ".hermes_history",
      "runtime/state.db",
      "workspace-*",
    ],
  },
  "langchain-deepagents-code": {
    dir: "/sandbox/.deepagents",
    targets: [".state", "skills", "agent/skills", "config.toml", "hooks.json", "workspace-*"],
  },
}

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

function parseDeleteAgent(body: any) {
  const raw = typeof body?.agent === "string" ? body.agent.trim() : "openclaw"
  return PERSISTENT_STATE_TARGETS[raw] ? raw : "openclaw"
}

async function resolveDeleteTarget(ref: string, agent: string) {
  try {
    const sandbox = await resolveSandboxRef(ref)
    return {
      requested: ref,
      sandboxName: validateSandboxName(sandbox.name),
      sandboxId: sandbox.id,
      agent,
      resolved: true,
    }
  } catch (error) {
    return {
      requested: ref,
      sandboxName: validateSandboxName(ref),
      sandboxId: null,
      agent: "openclaw",
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

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function isSafeManifestRelativePath(value: string) {
  return Boolean(value) && !value.startsWith("/") && !value.split("/").includes("..")
}

async function wipePersistentSandboxState(sandboxName: string, agent: string | null | undefined) {
  const agentName = agent || "openclaw"
  const contract = PERSISTENT_STATE_TARGETS[agentName] || PERSISTENT_STATE_TARGETS.openclaw
  const targets = contract.targets.filter(isSafeManifestRelativePath)
  if (targets.length === 0) return { ok: true as const, skipped: true as const, reason: "no safe state targets" }

  const startedAt = Date.now()
  const script = `cd ${shellQuote(contract.dir)} 2>/dev/null || exit 0; rm -rf -- ${targets
    .map((target) => (target === "workspace-*" ? target : shellQuote(target)))
    .join(" ")}`
  console.log(`[sandbox/delete] state-wipe:start sandbox=${sandboxName} agent=${agentName}`)
  try {
    const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", script], {
      env: hostCommandEnv({
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
      }),
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    })
    console.log(`[sandbox/delete] state-wipe:done sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)}`)
    return { ok: true as const, stdout: String(stdout).trim(), stderr: String(stderr).trim() }
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error ?? "Persistent state wipe failed")
    console.warn(`[sandbox/delete] state-wipe:warning sandbox=${sandboxName} elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return {
      ok: false as const,
      stdout: String(error?.stdout || "").trim(),
      stderr: String(error?.stderr || "").trim(),
      error: message,
      warning: "Could not wipe persistent sandbox state before delete; re-onboarding with the same name may resurface old files.",
    }
  }
}

function isSandboxNotFound(output: string) {
  return /sandbox not found|status:\s*NotFound|not present in the live OpenShell gateway/i.test(output)
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
    const target = await resolveDeleteTarget(parseDeleteTarget(body), parseDeleteAgent(body))

    // Tear down the Hermes remote-desktop exposure (Traefik rule, forward
    // unit, UFW, access record) before the sandbox goes away. Best effort:
    // a teardown failure must not block the delete itself.
    let hermesRemoteTeardown: { ok: boolean; error?: string } | null = null
    if (readHermesRemoteAccess(target.sandboxName)) {
      hermesRemoteTeardown = await unexposeHermesRemote(target.sandboxName)
      if (!hermesRemoteTeardown.ok) {
        console.log(`[sandbox/delete] hermes-remote teardown failed sandbox=${target.sandboxName} error=${hermesRemoteTeardown.error}`)
      }
    }

    // Upstream #26: wipe persistent sandbox state before delete.
    const stateWipe = await wipePersistentSandboxState(target.sandboxName, target.agent)
    const result = await deleteSandbox(target.sandboxName)
    const deleteOutput = [result.error, result.stdout, result.stderr].filter(Boolean).join("\n")
    const openShellAlreadyGone = !result.ok && isSandboxNotFound(deleteOutput)

    if (!result.ok && !openShellAlreadyGone) {
      return NextResponse.json({
        ok: false,
        deleted: false,
        requested: target.requested,
        sandboxName: target.sandboxName,
        sandboxId: target.sandboxId,
        resolved: target.resolved,
        resolveError: target.resolveError,
        stateWipe,
        error: result.error,
        stdout: result.stdout,
        stderr: result.stderr,
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
      stdout: result.stdout,
      stderr: result.stderr,
      openShellAlreadyGone,
      stateWipe,
      openShell: result,
      deletion,
      hermesRemoteTeardown,
      note: deleted ? "Sandbox delete completed." : "Sandbox delete command completed, but inventory still reports the sandbox.",
    }, { status: deleted ? 200 : 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox delete failed"
    const status = /required|must be|too long|name or id/.test(message) ? 400 : 500
    console.log(`[sandbox/delete] request:error elapsedMs=${elapsedMs(startedAt)} message=${message}`)
    return NextResponse.json({ ok: false, deleted: false, error: message }, { status })
  }
}
