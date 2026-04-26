import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { listMcpServers, sandboxCanAccessMcpServer } from "./mcpServerStore"

export type SandboxMcpBrokerSession = {
  sandboxId: string
  sandboxName: string | null
  tokenHash: string
  enabled: boolean
  createdAt: string
  rotatedAt: string
  expiresAt: string | null
}

type StoreShape = {
  sessions: Record<string, SandboxMcpBrokerSession>
}

const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const STORE_PATH = path.join(STORE_DIR, "mcp-broker-sessions.json")
const DEFAULT_TOKEN_TTL_HOURS = Number.parseInt(process.env.MCP_BROKER_TOKEN_TTL_HOURS || "168", 10)

function emptyStore(): StoreShape {
  return { sessions: {} }
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object"
      ? parsed
      : emptyStore()
  } catch {
    return emptyStore()
  }
}

async function writeStore(store: StoreShape) {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 })
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function expiryFromNow() {
  if (!Number.isFinite(DEFAULT_TOKEN_TTL_HOURS) || DEFAULT_TOKEN_TTL_HOURS <= 0) return null
  return new Date(Date.now() + DEFAULT_TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString()
}

export async function rotateSandboxMcpBrokerSession(sandboxId: string, sandboxName?: string | null) {
  const store = await readStore()
  const token = `osmcp_${randomBytes(32).toString("base64url")}`
  const now = new Date().toISOString()
  const existing = store.sessions[sandboxId]
  const session: SandboxMcpBrokerSession = {
    sandboxId,
    sandboxName: sandboxName || existing?.sandboxName || null,
    tokenHash: tokenHash(token),
    enabled: true,
    createdAt: existing?.createdAt || now,
    rotatedAt: now,
    expiresAt: expiryFromNow(),
  }
  store.sessions[sandboxId] = session
  await writeStore(store)
  return { session, token }
}

export async function verifySandboxMcpBrokerToken(token: string) {
  const store = await readStore()
  const hash = tokenHash(token)
  const session = Object.values(store.sessions).find((candidate) => safeEqual(candidate.tokenHash, hash))
  if (!session || !session.enabled) return null
  if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return null
  return session
}

export async function listAllowedBrokerServers(session: SandboxMcpBrokerSession) {
  const inventory = await listMcpServers()
  return inventory.servers.filter((server) => sandboxCanAccessMcpServer(server, session.sandboxId, session.sandboxName))
}

export function readBrokerToken(request: Request) {
  const authorization = request.headers.get("authorization") || ""
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  return bearer || request.headers.get("x-openshell-mcp-token")?.trim() || ""
}
