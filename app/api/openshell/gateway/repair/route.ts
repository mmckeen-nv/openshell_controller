import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { cp, mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { OPENSHELL_BIN, OPENSHELL_XDG_CONFIG_HOME, hostCommandEnv } from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)
const OPENSHELL_GATEWAY = process.env.OPENSHELL_GATEWAY || "nemoclaw"

function sanitizeGatewayName(value: string) {
  const name = value.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(name)) throw new Error("invalid gateway name")
  return name
}

async function activeGatewayName() {
  try {
    const raw = await readFile(path.join(OPENSHELL_XDG_CONFIG_HOME, "openshell/active_gateway"), "utf8")
    return sanitizeGatewayName(raw)
  } catch {
    return sanitizeGatewayName(OPENSHELL_GATEWAY)
  }
}

async function runOpenShell(args: string[], timeout = 90000) {
  const { stdout, stderr } = await execFileAsync(OPENSHELL_BIN, args, {
    env: hostCommandEnv({
      OPENSHELL_GATEWAY,
    }),
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() }
}

async function backupOpenShellConfig() {
  const source = path.join(OPENSHELL_XDG_CONFIG_HOME, "openshell")
  const backupRoot = path.join(OPENSHELL_XDG_CONFIG_HOME, "openshell-dashboard-backups")
  const backupPath = path.join(backupRoot, `openshell-${Date.now().toString(36)}`)
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await cp(source, backupPath, { recursive: true, force: false })
  return backupPath
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const gateway = sanitizeGatewayName(typeof body?.gateway === "string" && body.gateway.trim() ? body.gateway : await activeGatewayName())
    const backupPath = await backupOpenShellConfig()
    const start = await runOpenShell(["gateway", "start", "--name", gateway])
    const select = await runOpenShell(["gateway", "select", gateway], 30000)
    const verify = await runOpenShell(["sandbox", "list"], 30000)

    return NextResponse.json({
      ok: true,
      gateway,
      backupPath,
      warning: "OpenShell gateway trust repair backed up local OpenShell config, restarted the selected gateway, reselected it, and verified sandbox inventory. Use this only when gateway TLS trust is out of sync.",
      start,
      select,
      verify,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to repair OpenShell gateway trust"
    return NextResponse.json({ ok: false, error: message }, { status: /invalid|required/.test(message) ? 400 : 500 })
  }
}
