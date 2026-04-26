import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type McpTransport = "stdio" | "http"

export type McpCatalogEntry = {
  id: string
  name: string
  summary: string
  websiteUrl?: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  tags: string[]
}

export type McpServerInstall = McpCatalogEntry & {
  installedAt: string
  updatedAt: string
  source: "catalog" | "custom" | "registry"
  enabled: boolean
  accessMode: "disabled" | "allow_all" | "allow_only"
  allowedSandboxIds: string[]
}

type StoreShape = {
  servers: Record<string, McpServerInstall>
}

const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const STORE_PATH = path.join(STORE_DIR, "mcp-servers.json")

export const MCP_SERVER_CATALOG: McpCatalogEntry[] = [
  {
    id: "blender-mcp",
    name: "Blender MCP",
    summary: "Connect AI clients to Blender for natural-language 3D scene inspection, creation, and editing. Requires the Blender MCP add-on in Blender.",
    websiteUrl: "https://blendermcp.org/",
    transport: "stdio",
    command: "uvx",
    args: ["blender-mcp"],
    env: {},
    tags: ["blender", "3d", "creative"],
  },
  {
    id: "filesystem",
    name: "Filesystem",
    summary: "Expose selected local directories to MCP clients through a stdio server.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/sandbox"],
    env: {},
    tags: ["files", "local"],
  },
  {
    id: "memory",
    name: "Memory",
    summary: "Provide a local knowledge graph for persistent notes and relationships.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    env: {},
    tags: ["state", "local"],
  },
  {
    id: "git",
    name: "Git",
    summary: "Inspect and operate on a local git repository from an MCP client.",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-git", "--repository", process.cwd()],
    env: {},
    tags: ["repo", "developer"],
  },
  {
    id: "fetch",
    name: "Fetch",
    summary: "Retrieve web content for MCP clients that need URL context.",
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
    env: {},
    tags: ["web", "utility"],
  },
]

function emptyStore(): StoreShape {
  return { servers: {} }
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? "").trim()).filter(Boolean)
}

function normalizeEnv(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, envValue]) => [key.trim(), String(envValue ?? "").trim()])
      .filter(([key]) => Boolean(key)),
  )
}

function normalizeTransport(value: unknown): McpTransport {
  return value === "http" ? "http" : "stdio"
}

function normalizeInstall(input: Partial<McpServerInstall>, existing?: McpServerInstall | null): McpServerInstall {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : existing?.name || "MCP Server"
  const id = slugify(typeof input.id === "string" && input.id.trim() ? input.id : existing?.id || name)
  if (!id) throw new Error("server id is required")

  const command = typeof input.command === "string" ? input.command.trim() : existing?.command || ""
  if (!command) throw new Error("server command is required")

  const now = new Date().toISOString()
  return {
    id,
    name,
    summary: typeof input.summary === "string" ? input.summary.trim() : existing?.summary || "",
    websiteUrl: typeof input.websiteUrl === "string" ? input.websiteUrl.trim() : existing?.websiteUrl,
    transport: normalizeTransport(input.transport ?? existing?.transport),
    command,
    args: normalizeStringArray(input.args ?? existing?.args),
    env: normalizeEnv(input.env ?? existing?.env),
    tags: normalizeStringArray(input.tags ?? existing?.tags),
    installedAt: existing?.installedAt || now,
    updatedAt: now,
    source: input.source === "custom" || input.source === "registry" ? input.source : existing?.source || "catalog",
    enabled: input.enabled ?? existing?.enabled ?? true,
    accessMode: input.accessMode === "allow_all" || input.accessMode === "allow_only" || input.accessMode === "disabled"
      ? input.accessMode
      : existing?.accessMode || "disabled",
    allowedSandboxIds: normalizeStringArray(input.allowedSandboxIds ?? existing?.allowedSandboxIds),
  }
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && parsed.servers && typeof parsed.servers === "object"
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

export function buildMcpClientConfig(servers: McpServerInstall[]) {
  return {
    mcpServers: Object.fromEntries(
      servers
        .filter((server) => server.enabled)
        .map((server) => [
          server.id,
          server.transport === "http"
            ? {
                url: server.command,
                ...(Object.keys(server.env).length > 0 ? { headers: server.env } : {}),
              }
            : {
                command: server.command,
                args: server.args,
                ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
              },
        ]),
    ),
  }
}

export function sandboxCanAccessMcpServer(server: McpServerInstall, sandboxId: string, sandboxName?: string | null) {
  if (!server.enabled || server.accessMode === "disabled") return false
  if (server.accessMode === "allow_all") return true
  const allowed = new Set(server.allowedSandboxIds)
  return allowed.has(sandboxId) || Boolean(sandboxName && allowed.has(sandboxName))
}

export async function listMcpServers() {
  const store = await readStore()
  const servers = Object.values(store.servers).sort((a, b) => a.name.localeCompare(b.name))
  return {
    catalog: MCP_SERVER_CATALOG,
    servers,
    config: buildMcpClientConfig(servers),
  }
}

export async function installMcpServer(input: Partial<McpServerInstall>) {
  const store = await readStore()
  const fromCatalog = typeof input.id === "string"
    ? MCP_SERVER_CATALOG.find((entry) => entry.id === input.id)
    : null
  const next = normalizeInstall(
    {
      ...fromCatalog,
      ...input,
      source: input.source || (fromCatalog ? "catalog" : "custom"),
    },
    typeof input.id === "string" ? store.servers[slugify(input.id)] : null,
  )
  store.servers[next.id] = next
  await writeStore(store)
  return next
}

export async function setMcpServerEnabled(serverId: string, enabled: boolean) {
  const store = await readStore()
  const id = slugify(serverId)
  const existing = store.servers[id]
  if (!existing) throw new Error("MCP server is not installed")
  store.servers[id] = normalizeInstall({ ...existing, enabled }, existing)
  await writeStore(store)
  return store.servers[id]
}

export async function updateMcpServerAccess(
  serverId: string,
  input: {
    enabled?: boolean
    accessMode?: McpServerInstall["accessMode"]
    allowedSandboxIds?: string[]
  },
) {
  const store = await readStore()
  const id = slugify(serverId)
  const existing = store.servers[id]
  if (!existing) throw new Error("MCP server is not installed")
  store.servers[id] = normalizeInstall({
    ...existing,
    enabled: input.enabled ?? existing.enabled,
    accessMode: input.accessMode ?? existing.accessMode,
    allowedSandboxIds: input.allowedSandboxIds ?? existing.allowedSandboxIds,
  }, existing)
  await writeStore(store)
  return store.servers[id]
}

export async function uninstallMcpServer(serverId: string) {
  const store = await readStore()
  const id = slugify(serverId)
  if (!store.servers[id]) throw new Error("MCP server is not installed")
  delete store.servers[id]
  await writeStore(store)
  return { id }
}
