#!/usr/bin/env node
import { spawn, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { WebSocket } from "ws"

const execFileAsync = promisify(execFile)
const DASHBOARD_PORT_BASE = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_PORT_BASE || "19000", 10)
const DASHBOARD_PORT_RANGE = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_PORT_RANGE || "2000", 10)
const REMOTE_DASHBOARD_PORT = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_REMOTE_PORT || "18789", 10)
const OPENSHELL_GATEWAY = process.env.OPENSHELL_GATEWAY || "nemoclaw"
const CONTROL_UI_ORIGIN = process.env.OPENCLAW_SANDBOX_CONTROL_UI_ORIGIN || "http://127.0.0.1:18789"
const CONNECT_TIMEOUT_MS = Number.parseInt(process.env.INTER_SANDBOX_CHAT_OPENCLAW_CONNECT_TIMEOUT_MS || "15000", 10)
const SEND_TIMEOUT_MS = Number.parseInt(process.env.INTER_SANDBOX_CHAT_OPENCLAW_SEND_TIMEOUT_MS || "120000", 10)
const SESSION_KEY = process.env.INTER_SANDBOX_CHAT_OPENCLAW_SESSION_KEY || "inter-sandbox-chat"

function firstExisting(candidates, fallback) {
  return candidates.find((candidate) => candidate && existsSync(candidate)) || fallback
}

const OPENSHELL_BIN = firstExisting([
  process.env.OPENSHELL_BIN,
  path.join(os.homedir(), ".local/bin/openshell"),
  "/usr/local/bin/openshell",
  "/opt/homebrew/bin/openshell",
], "openshell")

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim()
}

function cleanSandboxName(value) {
  const sandboxName = cleanText(value)
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sandboxName)) {
    throw new Error("sandbox name is required for OpenClaw dispatch")
  }
  return sandboxName
}

function hashSandboxId(value) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

function getDashboardPort(sandboxName) {
  return DASHBOARD_PORT_BASE + (hashSandboxId(sandboxName) % DASHBOARD_PORT_RANGE)
}

function buildSandboxSshArgs(sandboxName, extraArgs) {
  return [
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", `ProxyCommand=${OPENSHELL_BIN} ssh-proxy --gateway-name ${OPENSHELL_GATEWAY} --name ${sandboxName}`,
    `sandbox@openshell-${sandboxName}`,
    ...extraArgs,
  ]
}

async function execSandboxSsh(sandboxName, command, timeoutMs = 10000) {
  return await execFileAsync("ssh", buildSandboxSshArgs(sandboxName, [command]), {
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  })
}

function canConnectPort(port, timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    const done = (ok) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}

async function waitForPort(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnectPort(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function ensureRemoteDashboard(sandboxName) {
  const command = [
    `curl -fsS --max-time 2 http://127.0.0.1:${REMOTE_DASHBOARD_PORT}/ >/dev/null 2>&1`,
    "||",
    `(nohup /usr/local/bin/openclaw gateway run --allow-unconfigured --bind loopback --port ${REMOTE_DASHBOARD_PORT} >/tmp/gateway.log 2>&1 &)`,
  ].join(" ")
  await execSandboxSsh(sandboxName, command, 15000).catch(() => null)
}

async function ensureDashboardTunnel(sandboxName, port) {
  if (await canConnectPort(port)) return true
  await ensureRemoteDashboard(sandboxName)

  const child = spawn("ssh", buildSandboxSshArgs(sandboxName, [
    "-N",
    "-L", `127.0.0.1:${port}:127.0.0.1:${REMOTE_DASHBOARD_PORT}`,
  ]), {
    detached: true,
    env: process.env,
    stdio: "ignore",
  })
  child.unref()
  return await waitForPort(port, 8000)
}

async function readGatewayToken(sandboxName) {
  const script = [
    'const fs=require("fs")',
    'const cfg=JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json","utf8"))',
    'const token=cfg?.gateway?.auth?.token||cfg?.gateway?.token||""',
    'if(token) process.stdout.write(String(token))',
  ].join(";")
  const { stdout } = await execSandboxSsh(sandboxName, `node -e '${script}'`, 8000)
  const token = cleanText(stdout)
  if (!token) throw new Error("OpenClaw gateway token was not found in sandbox config")
  return token
}

async function readStdinJson() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (!raw) throw new Error("dispatch payload is required on stdin")
  return JSON.parse(raw)
}

function randomId() {
  return randomUUID()
}

class GatewayClient {
  constructor({ url, token, sessionKey }) {
    this.url = url
    this.token = token
    this.sessionKey = sessionKey
    this.ws = null
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.url, {
      headers: { origin: CONTROL_UI_ORIGIN },
    })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`OpenClaw websocket connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
      this.ws.once("open", () => {
        clearTimeout(timeout)
        resolve()
      })
      this.ws.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    this.ws.on("message", (data) => this.handleMessage(data))
    await this.request("connect", {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: "openclaw-control-ui",
        version: "openshell-inter-sandbox-chat-sidecar",
        platform: "node",
        mode: "webchat",
        instanceId: "openshell-inter-sandbox-chat-sidecar",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"],
      caps: ["tool-events"],
      auth: { token: this.token },
      userAgent: "openshell-controller/inter-sandbox-chat-sidecar",
      locale: "en-US",
    }, CONNECT_TIMEOUT_MS)
  }

  handleMessage(data) {
    let message
    try {
      message = JSON.parse(String(data))
    } catch {
      return
    }
    if (message.type !== "res") return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.ok) pending.resolve(message.payload)
    else {
      const detail = message.error?.message || message.error?.code || "OpenClaw request failed"
      const error = new Error(detail)
      error.details = message.error
      pending.reject(error)
    }
  }

  request(method, params, timeoutMs = SEND_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("OpenClaw websocket is not connected"))
    }

    const id = randomId()
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      })
    })
    this.ws.send(JSON.stringify({ type: "req", id, method, params }))
    return promise
  }

  async sendChat(message, idempotencyKey) {
    return await this.request("chat.send", {
      sessionKey: this.sessionKey,
      message,
      deliver: false,
      idempotencyKey,
    }, SEND_TIMEOUT_MS)
  }

  close() {
    this.ws?.close(1000, "done")
    this.ws = null
  }
}

function buildOpenClawMessage(payload) {
  const rawMessage = cleanText(payload?.message?.message)
  if (process.env.INTER_SANDBOX_CHAT_OPENCLAW_RAW_MESSAGE === "1") return rawMessage

  const room = cleanText(payload?.room || payload?.message?.room, "lobby")
  const sender = cleanText(payload?.message?.sender, "operator")
  const sandboxLabel = cleanText(payload?.sandboxName || payload?.sandboxId, "this sandbox")
  return [
    "Inter-Sandbox Chat message",
    `Room: ${room}`,
    `From: ${sender}`,
    `Origin: ${cleanText(payload?.message?.origin, "sandbox")}`,
    "",
    rawMessage,
    "",
    `Please handle this as a direct message for ${sandboxLabel}. This dispatch contains only the newest claimed chat message, not the whole room history. If the Inter-Sandbox Chat MCP server is available and a shared-room reply is appropriate, post your reply with post_message to room "${room}" and target the intended sandbox.`,
  ].join("\n")
}

async function main() {
  const payload = await readStdinJson()
  const sandboxName = cleanSandboxName(payload.sandboxName || payload.sandboxId)
  const message = buildOpenClawMessage(payload)
  if (!message) throw new Error("message text is required")

  const port = getDashboardPort(sandboxName)
  const tunnelReady = await ensureDashboardTunnel(sandboxName, port)
  if (!tunnelReady) throw new Error(`OpenClaw dashboard tunnel did not become ready on 127.0.0.1:${port}`)

  const token = await readGatewayToken(sandboxName)
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}/`,
    token,
    sessionKey: SESSION_KEY,
  })

  try {
    await client.connect()
    const result = await client.sendChat(message, payload.message?.id || randomId())
    process.stdout.write(`${JSON.stringify({
      status: "processed",
      note: `sent to OpenClaw chat session ${SESSION_KEY}`,
      openclaw: {
        sessionKey: SESSION_KEY,
        runId: result?.runId || null,
        port,
      },
    })}\n`)
  } finally {
    client.close()
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    status: "failed",
    note: error instanceof Error ? error.message : "OpenClaw dispatch failed",
  })}\n`)
})
