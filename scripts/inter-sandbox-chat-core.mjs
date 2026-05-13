import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(os.homedir(), ".nemoclaw-dashboard")
export const STORE_PATH = process.env.INTER_SANDBOX_CHAT_STORE || path.join(STORE_DIR, "inter-sandbox-chat.json")
export const MAX_MESSAGES_PER_ROOM = Number.parseInt(process.env.INTER_SANDBOX_CHAT_ROOM_LIMIT || "500", 10)
export const MAX_MESSAGE_LENGTH = Number.parseInt(process.env.INTER_SANDBOX_CHAT_MESSAGE_LIMIT || "8000", 10)

const ACK_STATUSES = new Set(["received", "processed", "failed"])

export function nowIso() {
  return new Date().toISOString()
}

export function cleanRoom(value) {
  const room = String(value || "lobby")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return room || "lobby"
}

export function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim()
}

export function cleanOrigin(value) {
  return cleanText(value, "sandbox").toLowerCase() === "operator" ? "operator" : "sandbox"
}

export function cleanAckStatus(value) {
  const status = cleanText(value, "received").toLowerCase()
  return ACK_STATUSES.has(status) ? status : "received"
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((entry) => cleanText(entry)).filter(Boolean)))
}

export function messageNeedsAck(message) {
  return message?.origin === "operator" && message?.requiresAck === true
}

export function messageMatchesOrigins(message, origins = ["operator"]) {
  const allowedOrigins = normalizeStringArray(origins).map((origin) => cleanOrigin(origin))
  return allowedOrigins.includes(cleanOrigin(message?.origin))
}

export function messageFromActor(message, { agentId, sandboxId, sandboxName } = {}) {
  const sender = cleanText(message?.sender)
  if (!sender) return false
  return (
    Boolean(agentId && sender === cleanText(agentId)) ||
    Boolean(sandboxId && sender === cleanText(sandboxId)) ||
    Boolean(sandboxName && sender === cleanText(sandboxName))
  )
}

export function roomData(store, roomId) {
  const existing = store.rooms?.[roomId] && typeof store.rooms[roomId] === "object" ? store.rooms[roomId] : {}
  const messages = Array.isArray(existing.messages) ? existing.messages : []
  const receipts = existing.receipts && typeof existing.receipts === "object" ? existing.receipts : {}
  const cursors = existing.cursors && typeof existing.cursors === "object" ? existing.cursors : {}
  return { ...existing, messages, receipts, cursors }
}

export async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && parsed.rooms && typeof parsed.rooms === "object"
      ? parsed
      : { rooms: {} }
  } catch {
    return { rooms: {} }
  }
}

export async function writeStore(store) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true, mode: 0o700 })
  await writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
}

export function messageTargetsAgent(message, { agentId, sandboxId, sandboxName, includeBroadcast = false } = {}) {
  const targets = message?.targets && typeof message.targets === "object" ? message.targets : {}
  const targetAgentIds = normalizeStringArray(targets.agentIds)
  const targetSandboxIds = normalizeStringArray(targets.sandboxIds)
  const targetSandboxNames = normalizeStringArray(targets.sandboxNames)
  const hasExplicitTargets = targetAgentIds.length > 0 || targetSandboxIds.length > 0 || targetSandboxNames.length > 0
  if (!hasExplicitTargets) {
    if (includeBroadcast) return true
    const room = cleanRoom(message?.room)
    return Boolean(
      room &&
      (
        (sandboxId && room === cleanRoom(sandboxId)) ||
        (sandboxName && room === cleanRoom(sandboxName)) ||
        (agentId && room === cleanRoom(agentId))
      ),
    )
  }

  const agent = cleanText(agentId)
  const sandbox = cleanText(sandboxId)
  const name = cleanText(sandboxName)
  return (
    Boolean(agent && targetAgentIds.includes(agent)) ||
    Boolean(sandbox && targetSandboxIds.includes(sandbox)) ||
    Boolean(name && targetSandboxNames.includes(name))
  )
}

export function receiptForActor(room, messageId, actorId) {
  const receipts = room.receipts?.[messageId] && typeof room.receipts[messageId] === "object" ? room.receipts[messageId] : {}
  return receipts[actorId] && typeof receipts[actorId] === "object" ? receipts[actorId] : null
}

export async function postChatMessage({
  room,
  sender,
  message,
  origin = "sandbox",
  ackToken,
  targetAgentIds,
  targetSandboxIds,
  targetSandboxNames,
}) {
  const store = await readStore()
  const roomId = cleanRoom(room)
  const senderName = cleanText(sender, "anonymous-sandbox").slice(0, 120) || "anonymous-sandbox"
  const text = cleanText(message).slice(0, MAX_MESSAGE_LENGTH)
  if (!text) return { ok: false, error: "message is required" }

  const currentRoom = roomData(store, roomId)
  const messageOrigin = cleanOrigin(origin)
  const requiresAck = messageOrigin === "operator"
  const targets = {
    agentIds: normalizeStringArray(targetAgentIds),
    sandboxIds: normalizeStringArray(targetSandboxIds),
    sandboxNames: normalizeStringArray(targetSandboxNames),
  }
  const hasTargets = targets.agentIds.length > 0 || targets.sandboxIds.length > 0 || targets.sandboxNames.length > 0
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    at: nowIso(),
    room: roomId,
    sender: senderName,
    origin: messageOrigin,
    requiresAck,
    ...(requiresAck ? { ackToken: cleanText(ackToken).slice(0, 160) || undefined } : {}),
    ...(hasTargets ? { targets } : {}),
    message: text,
  }

  store.rooms[roomId] = {
    ...currentRoom,
    updatedAt: entry.at,
    messages: [...currentRoom.messages, entry].slice(-Math.max(1, MAX_MESSAGES_PER_ROOM)),
    receipts: currentRoom.receipts,
    cursors: currentRoom.cursors,
  }
  await writeStore(store)
  return { ok: true, room: roomId, message: entry }
}

function writeReceiptToRoom(currentRoom, message, actorId, { agentId, sandboxId, status = "received", note }) {
  const roomId = cleanRoom(message.room)
  const receiptAt = nowIso()
  const existingReceipts = currentRoom.receipts[message.id] && typeof currentRoom.receipts[message.id] === "object"
    ? currentRoom.receipts[message.id]
    : {}
  const existing = existingReceipts[actorId] && typeof existingReceipts[actorId] === "object" ? existingReceipts[actorId] : {}
  const receipt = {
    ...existing,
    room: roomId,
    messageId: message.id,
    ackToken: message.ackToken || null,
    agentId: cleanText(agentId, actorId) || actorId,
    sandboxId: cleanText(sandboxId) || null,
    status: cleanAckStatus(status),
    at: receiptAt,
    firstReceivedAt: existing.firstReceivedAt || receiptAt,
    ...(note ? { note: cleanText(note).slice(0, 1000) } : {}),
  }

  currentRoom.receipts[message.id] = {
    ...existingReceipts,
    [actorId]: receipt,
  }
  return { receipt, receiptAt }
}

export async function recordChatMessageReceipt({ room, messageId, agentId, sandboxId, status = "received", note }) {
  const store = await readStore()
  const roomId = cleanRoom(room)
  const currentRoom = roomData(store, roomId)
  const message = currentRoom.messages.find((entry) => entry.id === messageId)
  if (!message) return { ok: false, error: "message not found", room: roomId, messageId }

  const actorId = cleanText(sandboxId) || cleanText(agentId, "anonymous-agent") || "anonymous-agent"
  const { receipt, receiptAt } = writeReceiptToRoom(currentRoom, message, actorId, {
    agentId,
    sandboxId,
    status,
    note,
  })
  store.rooms[roomId] = {
    ...currentRoom,
    updatedAt: receiptAt,
  }
  await writeStore(store)
  return { ok: true, room: roomId, messageId, receipt }
}

export async function ackChatMessage({ room, messageId, ackToken, agentId, sandboxId, status = "received", note }) {
  const store = await readStore()
  const roomId = cleanRoom(room)
  const currentRoom = roomData(store, roomId)
  const message = currentRoom.messages.find((entry) => entry.id === messageId)
  if (!message) return { ok: false, error: "message not found", room: roomId, messageId }
  if (!messageNeedsAck(message)) {
    return {
      ok: false,
      error: "message does not require acknowledgement",
      room: roomId,
      messageId,
      origin: message.origin || "sandbox",
    }
  }

  const providedAckToken = cleanText(ackToken)
  if (providedAckToken && message.ackToken && providedAckToken !== message.ackToken) {
    return { ok: false, error: "ack token does not match message", room: roomId, messageId }
  }

  const actorId = cleanText(sandboxId) || cleanText(agentId, "anonymous-agent") || "anonymous-agent"
  const { receipt, receiptAt } = writeReceiptToRoom(currentRoom, message, actorId, {
    agentId,
    sandboxId,
    status,
    note,
  })
  store.rooms[roomId] = {
    ...currentRoom,
    updatedAt: receiptAt,
  }
  await writeStore(store)
  return { ok: true, room: roomId, messageId, receipt }
}

export async function claimTargetedMessages({
  room = "lobby",
  agentId,
  sandboxId,
  sandboxName,
  limit = 5,
  includeBroadcast = false,
  autoAck = true,
  origins = ["operator"],
  excludeSelf = true,
  latestOnly = false,
  cursorId,
  receiptNote = "claimed by inter-sandbox chat cursor",
}) {
  const store = await readStore()
  const roomId = cleanRoom(room)
  const currentRoom = roomData(store, roomId)
  const actorId = cleanText(sandboxId) || cleanText(agentId, "anonymous-agent") || "anonymous-agent"
  const cursorKey = cleanText(cursorId) || actorId
  const cursor = currentRoom.cursors[cursorKey] && typeof currentRoom.cursors[cursorKey] === "object" ? currentRoom.cursors[cursorKey] : {}
  const afterId = cleanText(cursor.lastSeenMessageId)
  const start = afterId ? currentRoom.messages.findIndex((message) => message.id === afterId) + 1 : 0
  const matchedMessages = currentRoom.messages
    .slice(Math.max(0, start))
    .filter((message) => messageMatchesOrigins(message, origins))
    .filter((message) => messageTargetsAgent(message, { agentId, sandboxId, sandboxName, includeBroadcast }))
    .filter((message) => !excludeSelf || !messageFromActor(message, { agentId, sandboxId, sandboxName }))
    .filter((message) => !["processed", "failed"].includes(receiptForActor(currentRoom, message.id, actorId)?.status))
  const messages = (latestOnly ? matchedMessages.slice(-1) : matchedMessages)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 5)))

  if (messages.length === 0) {
    return { ok: true, room: roomId, agentId: cleanText(agentId), sandboxId: cleanText(sandboxId), count: 0, messages: [] }
  }

  const receiptAt = nowIso()
  let receiptsChanged = false
  if (autoAck) {
    for (const message of messages) {
      const existing = receiptForActor(currentRoom, message.id, actorId) || {}
      if (existing.status) continue
      writeReceiptToRoom(currentRoom, message, actorId, {
        agentId,
        sandboxId,
        status: "received",
        note: receiptNote,
      })
      receiptsChanged = true
    }
  }

  currentRoom.cursors[cursorKey] = {
    ...cursor,
    lastSeenMessageId: messages[messages.length - 1].id,
    updatedAt: receiptAt,
  }
  store.rooms[roomId] = {
    ...currentRoom,
    updatedAt: receiptsChanged ? receiptAt : currentRoom.updatedAt,
  }
  await writeStore(store)
  return {
    ok: true,
    room: roomId,
    agentId: cleanText(agentId),
    sandboxId: cleanText(sandboxId),
    count: messages.length,
    messages,
  }
}

export async function claimOperatorMessages(options) {
  return await claimTargetedMessages({
    ...options,
    origins: ["operator"],
    excludeSelf: false,
  })
}

export async function listRooms() {
  const store = await readStore()
  return Object.entries(store.rooms)
    .map(([room, value]) => ({
      room,
      updatedAt: value?.updatedAt || null,
      messageCount: Array.isArray(value?.messages) ? value.messages.length : 0,
      latestMessageId: Array.isArray(value?.messages) && value.messages.length > 0
        ? value.messages[value.messages.length - 1].id
        : null,
    }))
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
}
