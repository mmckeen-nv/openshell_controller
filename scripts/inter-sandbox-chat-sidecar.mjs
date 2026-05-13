#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"
import {
  ackChatMessage,
  claimOperatorMessages,
  claimTargetedMessages,
  cleanText,
  listRooms,
  postChatMessage,
  recordChatMessageReceipt,
} from "./inter-sandbox-chat-core.mjs"

const STATE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(os.homedir(), ".nemoclaw-dashboard")
const MCP_SERVER_STORE_PATH = path.join(STATE_DIR, "mcp-servers.json")
const MCP_BROKER_SESSIONS_PATH = path.join(STATE_DIR, "mcp-broker-sessions.json")
const DEFAULT_OPENCLAW_DISPATCH_SCRIPT = fileURLToPath(new URL("./inter-sandbox-chat-openclaw-dispatch.mjs", import.meta.url))
const CHAT_SERVER_ID = "inter-sandbox-chat"
const SIDECAR_AGENT_PREFIX = "inter-sandbox-chat-sidecar"
const MAX_DISPATCH_OUTPUT_BYTES = 64 * 1024

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ""), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== "string") return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

function parseDispatchArgs() {
  const raw = process.env.INTER_SANDBOX_CHAT_DISPATCH_ARGS_JSON?.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((entry) => String(entry))
  } catch {
    return []
  }
}

const POLL_MS = parsePositiveInt(process.env.INTER_SANDBOX_CHAT_SIDECAR_POLL_MS, 5000)
const CLAIM_LIMIT = parsePositiveInt(process.env.INTER_SANDBOX_CHAT_SIDECAR_LIMIT, 5, 50)
const DISPATCH_TIMEOUT_MS = parsePositiveInt(process.env.INTER_SANDBOX_CHAT_DISPATCH_TIMEOUT_MS, 120000)
const CUSTOM_DISPATCH_COMMAND = cleanText(process.env.INTER_SANDBOX_CHAT_DISPATCH_COMMAND)
const DISPATCH_COMMAND = CUSTOM_DISPATCH_COMMAND || process.execPath
const DISPATCH_ARGS = CUSTOM_DISPATCH_COMMAND ? parseDispatchArgs() : [DEFAULT_OPENCLAW_DISPATCH_SCRIPT]
const DISPATCH_KIND = CUSTOM_DISPATCH_COMMAND ? "custom-command" : "openclaw-chat"
const POST_REPLIES = parseBoolean(process.env.INTER_SANDBOX_CHAT_SIDECAR_POST_REPLIES, true)
const PROCESS_BROADCAST = parseBoolean(process.env.INTER_SANDBOX_CHAT_SIDECAR_PROCESS_BROADCAST, false)
const RELAY_SANDBOX_MESSAGES = parseBoolean(process.env.INTER_SANDBOX_CHAT_SIDECAR_RELAY_SANDBOX_MESSAGES, true)
const SANDBOX_RELAY_LATEST_ONLY = parseBoolean(process.env.INTER_SANDBOX_CHAT_SIDECAR_SANDBOX_LATEST_ONLY, true)

let stopping = false
let timer = null
let lastIdleKey = ""
const activeDispatches = new Set()

function nowIso() {
  return new Date().toISOString()
}

function log(event, fields = {}) {
  const payload = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ")
  console.log(`[inter-sandbox-chat-sidecar] ts=${nowIso()} event=${event}${payload ? ` ${payload}` : ""}`)
}

function logIdle(key, event, fields = {}) {
  if (lastIdleKey === key) return
  lastIdleKey = key
  log(event, fields)
}

function clearIdle() {
  lastIdleKey = ""
}

async function readJson(pathname, fallback) {
  try {
    const parsed = JSON.parse(await readFile(pathname, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : fallback
  } catch {
    return fallback
  }
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((entry) => cleanText(entry)).filter(Boolean)))
}

async function readChatPolicy() {
  const store = await readJson(MCP_SERVER_STORE_PATH, { servers: {} })
  const server = store.servers?.[CHAT_SERVER_ID]
  if (!server || typeof server !== "object") {
    return { active: false, reason: "not-installed", accessMode: "disabled", allowedSandboxIds: [] }
  }

  const accessMode = server.accessMode === "allow_all" || server.accessMode === "allow_only"
    ? server.accessMode
    : "disabled"
  const allowedSandboxIds = normalizeStringArray(server.allowedSandboxIds)
  if (!server.enabled) return { active: false, reason: "disabled", accessMode, allowedSandboxIds }
  if (accessMode === "disabled") return { active: false, reason: "access-disabled", accessMode, allowedSandboxIds }
  if (accessMode === "allow_only" && allowedSandboxIds.length === 0) {
    return { active: false, reason: "allow-list-empty", accessMode, allowedSandboxIds }
  }
  return { active: true, reason: "enabled", accessMode, allowedSandboxIds }
}

function sessionIsUsable(session) {
  if (!session || typeof session !== "object") return false
  if (!session.enabled) return false
  if (!cleanText(session.sandboxId)) return false
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return false
  return true
}

async function readBrokerSessions() {
  const store = await readJson(MCP_BROKER_SESSIONS_PATH, { sessions: {} })
  return Object.values(store.sessions || {}).filter(sessionIsUsable)
}

function targetFromSession(session) {
  const sandboxId = cleanText(session.sandboxId)
  const sandboxName = cleanText(session.sandboxName)
  return {
    sandboxId,
    sandboxName: sandboxName || sandboxId,
    agentId: `${SIDECAR_AGENT_PREFIX}:${sandboxId}`,
    source: "broker-session",
  }
}

function targetFromAllowedId(id) {
  const sandboxId = cleanText(id)
  return {
    sandboxId,
    sandboxName: sandboxId,
    agentId: `${SIDECAR_AGENT_PREFIX}:${sandboxId}`,
    source: "allow-list",
  }
}

function targetKey(target) {
  return cleanText(target.sandboxId) || cleanText(target.sandboxName) || cleanText(target.agentId)
}

function sessionMatchesAllowedId(session, allowedId) {
  const allowed = cleanText(allowedId)
  return Boolean(
    allowed &&
    (allowed === cleanText(session.sandboxId) || allowed === cleanText(session.sandboxName)),
  )
}

function resolveTargets(policy, sessions) {
  const targets = []
  if (policy.accessMode === "allow_all") {
    targets.push(...sessions.map(targetFromSession))
  } else {
    for (const allowedId of policy.allowedSandboxIds) {
      const matchingSession = sessions.find((session) => sessionMatchesAllowedId(session, allowedId))
      targets.push(matchingSession ? targetFromSession(matchingSession) : targetFromAllowedId(allowedId))
    }
  }

  const seen = new Set()
  return targets.filter((target) => {
    const key = targetKey(target)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function appendLimited(current, chunk) {
  const next = current + chunk.toString("utf8")
  return next.length > MAX_DISPATCH_OUTPUT_BYTES ? next.slice(-MAX_DISPATCH_OUTPUT_BYTES) : next
}

function dispatchEnv(payload) {
  return {
    ...process.env,
    INTER_SANDBOX_CHAT_ROOM: payload.room,
    INTER_SANDBOX_CHAT_MESSAGE_ID: payload.message.id,
    INTER_SANDBOX_CHAT_MESSAGE: payload.message.message,
    INTER_SANDBOX_CHAT_SENDER: payload.message.sender,
    INTER_SANDBOX_CHAT_ACK_TOKEN: payload.message.ackToken || "",
    INTER_SANDBOX_CHAT_SANDBOX_ID: payload.sandboxId || "",
    INTER_SANDBOX_CHAT_SANDBOX_NAME: payload.sandboxName || "",
    INTER_SANDBOX_CHAT_AGENT_ID: payload.agentId || "",
  }
}

async function runDispatch(payload) {
  if (!DISPATCH_COMMAND) return { ok: false, error: "dispatch command is not configured" }

  return await new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false
    const child = spawn(DISPATCH_COMMAND, DISPATCH_ARGS, {
      cwd: process.cwd(),
      env: dispatchEnv(payload),
      stdio: ["pipe", "pipe", "pipe"],
    })
    activeDispatches.add(child)

    const timeout = setTimeout(() => {
      timedOut = true
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      }, 2500).unref()
    }, DISPATCH_TIMEOUT_MS)

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk)
    })
    child.once("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      activeDispatches.delete(child)
      resolve({ ok: false, error: error instanceof Error ? error.message : "dispatch failed", stderr })
    })
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      activeDispatches.delete(child)
      if (code === 0 && !timedOut) {
        resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() })
        return
      }
      const reason = timedOut
        ? `dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`
        : `dispatch exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}`
      resolve({ ok: false, error: reason, stderr: stderr.trim() })
    })

    child.stdin.end(`${JSON.stringify(payload)}\n`)
  })
}

function parseDispatchOutput(output) {
  const text = cleanText(output)
  if (!text) return { reply: "", status: "processed", note: "dispatch completed without output" }

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const status = cleanText(parsed.status).toLowerCase()
      return {
        reply: cleanText(parsed.reply ?? parsed.message),
        status: status === "failed" ? "failed" : "processed",
        note: cleanText(parsed.note ?? parsed.summary ?? parsed.status) || "dispatch completed",
      }
    }
  } catch {
    // Plain text stdout is treated as the sandbox reply.
  }

  return { reply: text, status: "processed", note: "dispatch returned plain text" }
}

async function processClaimedMessage(target, room, message) {
  const payload = {
    room,
    message,
    sandboxId: target.sandboxId,
    sandboxName: target.sandboxName,
    agentId: target.agentId,
  }
  log("dispatch-start", {
    room,
    messageId: message.id,
    sandboxId: target.sandboxId,
    sandboxName: target.sandboxName,
  })

  const result = await runDispatch(payload)
  if (!result.ok) {
    const note = [result.error, result.stderr].filter(Boolean).join(": ")
    const recordReceipt = message.origin === "operator" ? ackChatMessage : recordChatMessageReceipt
    await recordReceipt({
      room,
      messageId: message.id,
      ackToken: message.ackToken,
      agentId: target.agentId,
      sandboxId: target.sandboxId,
      status: "failed",
      note,
    })
    log("dispatch-failed", {
      room,
      messageId: message.id,
      sandboxId: target.sandboxId,
      reason: result.error,
    })
    return
  }

  const parsed = parseDispatchOutput(result.stdout)
  let postedReplyId = null
  if (POST_REPLIES && parsed.status !== "failed" && parsed.reply) {
    const posted = await postChatMessage({
      room,
      sender: target.sandboxName || target.sandboxId || target.agentId,
      message: parsed.reply,
      origin: "sandbox",
    })
    postedReplyId = posted.message?.id || null
  }

  const recordReceipt = message.origin === "operator" ? ackChatMessage : recordChatMessageReceipt
  await recordReceipt({
    room,
    messageId: message.id,
    ackToken: message.ackToken,
    agentId: target.agentId,
    sandboxId: target.sandboxId,
    status: parsed.status,
    note: parsed.note,
  })
  log("dispatch-complete", {
    room,
    messageId: message.id,
    sandboxId: target.sandboxId,
    status: parsed.status,
    postedReplyId,
  })
}

async function pollOnce() {
  const policy = await readChatPolicy()
  if (!policy.active) {
    logIdle(`inactive:${policy.reason}`, "inactive", { reason: policy.reason })
    return
  }

  const sessions = await readBrokerSessions()
  const targets = resolveTargets(policy, sessions)
  if (targets.length === 0) {
    logIdle(`no-targets:${policy.accessMode}`, "no-targets", {
      accessMode: policy.accessMode,
      sessionCount: sessions.length,
    })
    return
  }

  const rooms = await listRooms()
  if (rooms.length === 0) {
    logIdle("no-rooms", "no-rooms", { targetCount: targets.length })
    return
  }

  clearIdle()
  let claimedCount = 0
  for (const target of targets) {
    if (stopping) return
    for (const room of rooms) {
      if (stopping) return
      const claimed = await claimOperatorMessages({
        room: room.room,
        agentId: target.agentId,
        sandboxId: target.sandboxId,
        sandboxName: target.sandboxName,
        limit: CLAIM_LIMIT,
        includeBroadcast: PROCESS_BROADCAST,
        autoAck: true,
      })
      for (const message of claimed.messages || []) {
        claimedCount += 1
        await processClaimedMessage(target, room.room, message)
      }
      if (!RELAY_SANDBOX_MESSAGES) continue
      const relayed = await claimTargetedMessages({
        room: room.room,
        agentId: target.agentId,
        sandboxId: target.sandboxId,
        sandboxName: target.sandboxName,
        limit: CLAIM_LIMIT,
        includeBroadcast: PROCESS_BROADCAST,
        autoAck: true,
        origins: ["sandbox"],
        excludeSelf: true,
        latestOnly: SANDBOX_RELAY_LATEST_ONLY,
        cursorId: `${target.agentId}:sandbox-relay`,
        receiptNote: SANDBOX_RELAY_LATEST_ONLY
          ? "claimed latest sandbox message by inter-sandbox chat sidecar"
          : "claimed sandbox message by inter-sandbox chat sidecar",
      })
      for (const message of relayed.messages || []) {
        claimedCount += 1
        await processClaimedMessage(target, room.room, message)
      }
    }
  }

  if (claimedCount > 0) {
    log("poll-complete", { claimedCount, targetCount: targets.length, roomCount: rooms.length })
  }
}

async function loop() {
  const startedAt = Date.now()
  try {
    await pollOnce()
  } catch (error) {
    log("poll-error", {
      reason: error instanceof Error ? error.message : "unknown error",
    })
  }

  if (stopping) return
  const delay = Math.max(1000, POLL_MS - (Date.now() - startedAt))
  timer = setTimeout(loop, delay)
}

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  if (timer) clearTimeout(timer)
  for (const child of activeDispatches) {
    if (!child.killed) child.kill("SIGTERM")
  }
  log("stopping", { exitCode, activeDispatches: activeDispatches.size })
}

process.once("SIGINT", () => stop(130))
process.once("SIGTERM", () => stop(143))

log("started", {
  pollMs: POLL_MS,
  claimLimit: CLAIM_LIMIT,
  dispatchConfigured: Boolean(DISPATCH_COMMAND),
  dispatchKind: DISPATCH_KIND,
  processBroadcast: PROCESS_BROADCAST,
  postReplies: POST_REPLIES,
  relaySandboxMessages: RELAY_SANDBOX_MESSAGES,
  sandboxRelayLatestOnly: SANDBOX_RELAY_LATEST_ONLY,
})

await loop()
