#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import {
  MAX_MESSAGE_LENGTH,
  ackChatMessage,
  claimOperatorMessages,
  cleanRoom,
  cleanText,
  listRooms,
  messageNeedsAck,
  postChatMessage,
  readStore,
  roomData,
} from "./inter-sandbox-chat-core.mjs"

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
  version: "0.3.0",
})

server.registerTool(
  "post_message",
  {
    title: "Post Message",
    description: "Post a message into an inter-sandbox chat room. Sandbox-to-sandbox messages are normal chat and do not need acknowledgements. Operator-injected messages should set origin='operator'; only those messages are marked for agent acknowledgement.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      sender: z.string().default("anonymous-sandbox").describe("Sender name, usually the sandbox or agent name."),
      message: z.string().min(1).max(MAX_MESSAGE_LENGTH).describe("Message text to share with other sandboxes."),
      origin: z.enum(["sandbox", "operator"]).default("sandbox").describe("Message origin. Use 'operator' only for human/operator-injected chats that agents should acknowledge."),
      ackToken: z.string().optional().describe("Optional stable token supplied by the operator UI. Stored only for operator messages; omitted sandbox messages do not need receipts."),
      targetSandboxIds: z.array(z.string()).default([]).describe("Optional sandbox ids to notify. Use this for direct sandbox-to-sandbox chat without broadcasting a room."),
      targetSandboxNames: z.array(z.string()).default([]).describe("Optional sandbox names to notify. A room named for a sandbox also counts as targeted."),
      targetAgentIds: z.array(z.string()).default([]).describe("Optional sidecar/agent ids to notify."),
    },
  },
  async ({ room, sender, message, origin, ackToken, targetSandboxIds, targetSandboxNames, targetAgentIds }) => {
    return asText(await postChatMessage({
      room,
      sender,
      message,
      origin,
      ackToken,
      targetSandboxIds,
      targetSandboxNames,
      targetAgentIds,
    }))
  },
)

server.registerTool(
  "post_operator_message",
  {
    title: "Post Operator Message",
    description: "Post a human/operator-injected chat into a room. Messages created by this tool always have origin='operator' and requiresAck=true so agents know to acknowledge receipt with ack_message. Use post_message for normal sandbox-to-sandbox chat.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      sender: z.string().default("operator").describe("Operator or UI sender label."),
      message: z.string().min(1).max(MAX_MESSAGE_LENGTH).describe("Operator message text to share with agents."),
      ackToken: z.string().optional().describe("Optional stable token supplied by the operator UI for correlating receipts."),
      targetSandboxIds: z.array(z.string()).default([]).describe("Optional sandbox ids that should be woken by the controller sidecar."),
      targetSandboxNames: z.array(z.string()).default([]).describe("Optional sandbox names that should be woken by the controller sidecar."),
      targetAgentIds: z.array(z.string()).default([]).describe("Optional agent ids that should be woken by the controller sidecar."),
    },
  },
  async ({ room, sender, message, ackToken, targetSandboxIds, targetSandboxNames, targetAgentIds }) => {
    return asText(await postChatMessage({
      room,
      sender,
      message,
      origin: "operator",
      ackToken,
      targetSandboxIds,
      targetSandboxNames,
      targetAgentIds,
    }))
  },
)

server.registerTool(
  "read_messages",
  {
    title: "Read Messages",
    description: "Read recent messages from an inter-sandbox chat room. Important model behavior: acknowledge only operator-originated messages. If a returned message has origin='operator' and requiresAck=true, call ack_message immediately with status='received'. Do not acknowledge sandbox-originated messages.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      afterId: z.string().optional().describe("Only return messages after this message id."),
      limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of messages to return."),
    },
  },
  async ({ room, afterId, limit }) => {
    const store = await readStore()
    const roomId = cleanRoom(room)
    const messages = roomData(store, roomId).messages
    const start = afterId ? messages.findIndex((message) => message.id === afterId) + 1 : 0
    const selected = messages.slice(Math.max(0, start)).slice(-limit)
    return asText({ ok: true, room: roomId, count: selected.length, messages: selected })
  },
)

server.registerTool(
  "ack_message",
  {
    title: "Acknowledge Operator Message",
    description: "Acknowledge receipt or handling of an operator-originated chat message. Use this only for messages where origin='operator' and requiresAck=true. Never call this for sandbox-to-sandbox chat messages.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      messageId: z.string().min(1).describe("Operator message id being acknowledged."),
      ackToken: z.string().optional().describe("Optional operator ack token. If the message has a token, a provided token must match it."),
      agentId: z.string().default("anonymous-agent").describe("Stable acknowledging agent id."),
      sandboxId: z.string().optional().describe("Stable sandbox id or sandbox name for UI grouping."),
      status: z.enum(["received", "processed", "failed"]).default("received").describe("Use received immediately after seeing the operator message, then processed or failed after acting on it."),
      note: z.string().max(1000).optional().describe("Optional short machine-readable or human-readable note."),
    },
  },
  async ({ room, messageId, ackToken, agentId, sandboxId, status, note }) => {
    return asText(await ackChatMessage({ room, messageId, ackToken, agentId, sandboxId, status, note }))
  },
)

server.registerTool(
  "claim_operator_messages",
  {
    title: "Claim Operator Messages",
    description: "Return only new targeted operator messages for an agent/sandbox and optionally mark them received. Use this instead of polling read_messages from an LLM loop. Broadcast lobby messages are ignored unless includeBroadcast=true; messages in a room named for the sandbox are considered targeted.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      agentId: z.string().default("anonymous-agent").describe("Stable claiming agent id."),
      sandboxId: z.string().optional().describe("Stable sandbox id for cursoring and receipt grouping."),
      sandboxName: z.string().optional().describe("Sandbox name for target matching."),
      limit: z.number().int().min(1).max(50).default(5).describe("Maximum number of new operator messages to claim."),
      includeBroadcast: z.boolean().default(false).describe("When true, untargeted operator messages in the room are also claimable."),
      autoAck: z.boolean().default(true).describe("When true, writes a received receipt before returning messages."),
    },
  },
  async ({ room, agentId, sandboxId, sandboxName, limit, includeBroadcast, autoAck }) => {
    return asText(await claimOperatorMessages({ room, agentId, sandboxId, sandboxName, limit, includeBroadcast, autoAck }))
  },
)

server.registerTool(
  "get_message_receipts",
  {
    title: "Get Operator Message Receipts",
    description: "Return parseable acknowledgement state for an operator message. This is intended for operator UIs and orchestration; sandbox-to-sandbox messages normally have no receipts.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      messageId: z.string().min(1).describe("Message id to inspect."),
      expectedAgents: z.array(z.string()).default([]).describe("Optional agent or sandbox ids expected to acknowledge the operator message."),
    },
  },
  async ({ room, messageId, expectedAgents }) => {
    const store = await readStore()
    const roomId = cleanRoom(room)
    const currentRoom = roomData(store, roomId)
    const message = currentRoom.messages.find((entry) => entry.id === messageId) || null
    const receipts = currentRoom.receipts[messageId] && typeof currentRoom.receipts[messageId] === "object"
      ? currentRoom.receipts[messageId]
      : {}
    const expected = Array.from(new Set((expectedAgents || []).map((entry) => cleanText(entry)).filter(Boolean)))
    const pendingAgents = expected.filter((agent) => !receipts[agent])
    return asText({
      ok: true,
      room: roomId,
      messageId,
      requiresAck: messageNeedsAck(message),
      ackToken: message?.ackToken || null,
      receiptCount: Object.keys(receipts).length,
      receipts,
      expectedAgents: expected,
      pendingAgents,
      acknowledged: expected.length > 0 ? pendingAgents.length === 0 : Object.keys(receipts).length > 0,
    })
  },
)

server.registerTool(
  "list_operator_ack_status",
  {
    title: "List Operator Ack Status",
    description: "List recent operator messages with acknowledgement status for dashboards. Sandbox-originated messages are intentionally excluded because they do not require acknowledgements.",
    inputSchema: {
      room: z.string().default("lobby").describe("Chat room name. Defaults to lobby."),
      limit: z.number().int().min(1).max(100).default(50).describe("Maximum number of recent operator messages to inspect."),
      expectedAgents: z.array(z.string()).default([]).describe("Optional agent or sandbox ids expected to acknowledge each operator message."),
    },
  },
  async ({ room, limit, expectedAgents }) => {
    const store = await readStore()
    const roomId = cleanRoom(room)
    const currentRoom = roomData(store, roomId)
    const expected = Array.from(new Set((expectedAgents || []).map((entry) => cleanText(entry)).filter(Boolean)))
    const operatorMessages = currentRoom.messages
      .filter(messageNeedsAck)
      .slice(-limit)
      .map((message) => {
        const receipts = currentRoom.receipts[message.id] && typeof currentRoom.receipts[message.id] === "object"
          ? currentRoom.receipts[message.id]
          : {}
        const pendingAgents = expected.filter((agent) => !receipts[agent])
        return {
          messageId: message.id,
          ackToken: message.ackToken || null,
          at: message.at,
          sender: message.sender,
          message: message.message,
          receiptCount: Object.keys(receipts).length,
          receipts,
          pendingAgents,
          acknowledged: expected.length > 0 ? pendingAgents.length === 0 : Object.keys(receipts).length > 0,
        }
      })
    return asText({ ok: true, room: roomId, count: operatorMessages.length, expectedAgents: expected, operatorMessages })
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
    return asText({ ok: true, rooms: await listRooms() })
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
