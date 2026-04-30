#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(os.homedir(), ".nemoclaw-dashboard")
const STORE_PATH = process.env.INTER_SANDBOX_CHAT_STORE || path.join(STORE_DIR, "inter-sandbox-chat.json")
const MAX_MESSAGES_PER_ROOM = Number.parseInt(process.env.INTER_SANDBOX_CHAT_ROOM_LIMIT || "500", 10)
const MAX_MESSAGE_LENGTH = Number.parseInt(process.env.INTER_SANDBOX_CHAT_MESSAGE_LIMIT || "8000", 10)

function nowIso() {
  return new Date().toISOString()
}

function cleanRoom(value) {
  const room = String(value || "lobby")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return room || "lobby"
}

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim()
}

async function readStore() {
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

async function writeStore(store) {
  await mkdir(path.dirname(STORE_PATH), { recursive: true, mode: 0o700 })
  await writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 })
}

function asText(payload) {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  }
}

const server = new McpServer({
  name: "inter-sandbox-chat",
  version: "0.1.0",
})

server.registerTool(
  "post_message",
  {
    title: "Post Message",
    description: "Post a message into an inter-sandbox chat room. Use a stable sender name such as the sandbox name.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      sender: z.string().default("anonymous-sandbox").describe("Sender name, usually the sandbox or agent name."),
      message: z.string().min(1).max(MAX_MESSAGE_LENGTH).describe("Message text to share with other sandboxes."),
    },
  },
  async ({ room, sender, message }) => {
    const store = await readStore()
    const roomId = cleanRoom(room)
    const senderName = cleanText(sender, "anonymous-sandbox").slice(0, 120) || "anonymous-sandbox"
    const text = cleanText(message).slice(0, MAX_MESSAGE_LENGTH)
    if (!text) return asText({ ok: false, error: "message is required" })

    const messages = Array.isArray(store.rooms[roomId]?.messages) ? store.rooms[roomId].messages : []
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      at: nowIso(),
      room: roomId,
      sender: senderName,
      message: text,
    }

    store.rooms[roomId] = {
      updatedAt: entry.at,
      messages: [...messages, entry].slice(-Math.max(1, MAX_MESSAGES_PER_ROOM)),
    }
    await writeStore(store)
    return asText({ ok: true, room: roomId, message: entry })
  },
)

server.registerTool(
  "read_messages",
  {
    title: "Read Messages",
    description: "Read recent messages from an inter-sandbox chat room.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      afterId: z.string().optional().describe("Only return messages after this message id."),
      limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of messages to return."),
    },
  },
  async ({ room, afterId, limit }) => {
    const store = await readStore()
    const roomId = cleanRoom(room)
    const messages = Array.isArray(store.rooms[roomId]?.messages) ? store.rooms[roomId].messages : []
    const start = afterId ? messages.findIndex((message) => message.id === afterId) + 1 : 0
    const selected = messages.slice(Math.max(0, start)).slice(-limit)
    return asText({ ok: true, room: roomId, count: selected.length, messages: selected })
  },
)

server.registerTool(
  "list_rooms",
  {
    title: "List Rooms",
    description: "List inter-sandbox chat rooms that currently have messages.",
    inputSchema: {
      includeEmpty: z.boolean().default(false).describe("Reserved for compatibility; rooms are created when messages are posted."),
    },
  },
  async () => {
    const store = await readStore()
    const rooms = Object.entries(store.rooms)
      .map(([room, value]) => ({
        room,
        updatedAt: value?.updatedAt || null,
        messageCount: Array.isArray(value?.messages) ? value.messages.length : 0,
        latestMessageId: Array.isArray(value?.messages) && value.messages.length > 0
          ? value.messages[value.messages.length - 1].id
          : null,
      }))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    return asText({ ok: true, rooms })
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
