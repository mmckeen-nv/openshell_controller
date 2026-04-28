import { NextResponse } from "next/server"
import { Client } from "ssh2"
import { buildControllerNodePlan, type ControllerPlanRequest } from "@/app/lib/controllerNodePlan"

export const runtime = "nodejs"

type DeployRequest = ControllerPlanRequest & {
  remoteHost?: unknown
  remotePort?: unknown
  remoteUser?: unknown
  remotePassword?: unknown
  allowSudo?: unknown
  acceptUnknownHostKey?: unknown
  expectedHostKeySha256?: unknown
}

const SAFE_REMOTE_USER = /^[a-z_][a-z0-9_-]{0,31}$/i
const MAX_OUTPUT_BYTES = 160_000

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback
}

function port(value: unknown) {
  const parsed = Number.parseInt(String(value ?? "22"), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 22
}

function appendBounded(current: string, chunk: Buffer | string) {
  const next = current + String(chunk)
  return next.length > MAX_OUTPUT_BYTES ? next.slice(next.length - MAX_OUTPUT_BYTES) : next
}

function normalizeFingerprint(value: string) {
  return value.trim().replace(/^SHA256:/i, "")
}

function runRemoteDeploy(params: {
  host: string
  port: number
  username: string
  password: string
  script: string
  allowSudo: boolean
  acceptUnknownHostKey: boolean
  expectedHostKeySha256: string
}) {
  return new Promise<{ stdout: string; stderr: string; hostKeySha256: string | null }>((resolve, reject) => {
    const conn = new Client()
    let stdout = ""
    let stderr = ""
    let hostKeySha256: string | null = null
    let settled = false

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      conn.end()
      if (error) reject(error)
      else resolve({ stdout: stdout.trim(), stderr: stderr.trim(), hostKeySha256 })
    }

    const timer = setTimeout(() => {
      finish(new Error("Remote deploy timed out after 10 minutes"))
    }, 10 * 60 * 1000)

    conn
      .on("ready", () => {
        const command = params.allowSudo ? "sudo -S -p '' bash -s" : "bash -s"
        conn.exec(command, { pty: params.allowSudo }, (error, stream) => {
          if (error) {
            clearTimeout(timer)
            finish(error)
            return
          }

          stream
            .on("close", (code: number | null, signal: string | null) => {
              clearTimeout(timer)
              if (code === 0) {
                finish()
              } else {
                finish(new Error(`Remote deploy failed with exit code ${code ?? "unknown"}${signal ? ` signal ${signal}` : ""}`))
              }
            })
            .on("data", (chunk: Buffer) => {
              stdout = appendBounded(stdout, chunk)
            })

          stream.stderr.on("data", (chunk: Buffer) => {
            stderr = appendBounded(stderr, chunk)
          })

          if (params.allowSudo) stream.write(`${params.password}\n`)
          stream.end(`${params.script}\n`)
        })
      })
      .on("error", (error) => {
        clearTimeout(timer)
        finish(error)
      })
      .connect({
        host: params.host,
        port: params.port,
        username: params.username,
        password: params.password,
        readyTimeout: 30000,
        hostHash: "sha256",
        hostVerifier: (hashedKey: string) => {
          hostKeySha256 = hashedKey
          const expected = normalizeFingerprint(params.expectedHostKeySha256)
          if (expected) return hashedKey === expected
          return params.acceptUnknownHostKey
        },
      })
  })
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as DeployRequest
    const remoteHost = text(body.remoteHost, text(body.controllerHost))
    const remoteUser = text(body.remoteUser)
    const remotePassword = typeof body.remotePassword === "string" ? body.remotePassword : ""
    const expectedHostKeySha256 = text(body.expectedHostKeySha256)
    const acceptUnknownHostKey = Boolean(body.acceptUnknownHostKey)
    const allowSudo = Boolean(body.allowSudo)

    if (!remoteHost) throw new Error("remoteHost is required")
    if (!remoteUser || !SAFE_REMOTE_USER.test(remoteUser)) throw new Error("remoteUser must be a valid Linux username")
    if (!remotePassword) throw new Error("remotePassword is required for autodeploy")
    if (!expectedHostKeySha256 && !acceptUnknownHostKey) {
      throw new Error("Provide expectedHostKeySha256 or explicitly allow trust-on-first-deploy.")
    }

    const plan = buildControllerNodePlan({
      ...body,
      controllerHost: text(body.controllerHost, remoteHost),
    })
    const deployed = await runRemoteDeploy({
      host: remoteHost,
      port: port(body.remotePort),
      username: remoteUser,
      password: remotePassword,
      script: plan.commands.localBootstrap,
      allowSudo,
      acceptUnknownHostKey,
      expectedHostKeySha256,
    })

    return NextResponse.json({
      ok: true,
      ...plan,
      controller: plan.controller,
      hostKeySha256: deployed.hostKeySha256,
      stdout: deployed.stdout,
      stderr: deployed.stderr,
      note: allowSudo
        ? "Autodeploy completed using sudo. The controller service was installed when systemd was available."
        : "Autodeploy completed without sudo. Start the controller manually if systemd service installation was skipped.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to autodeploy controller node"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
