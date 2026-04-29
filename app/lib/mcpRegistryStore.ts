import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type McpRegistry = {
  id: string
  name: string
  baseUrl: string
  description: string
  addedAt: string
}

type StoreShape = {
  registries: McpRegistry[]
}

const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const STORE_PATH = path.join(STORE_DIR, "mcp-registries.json")

export const DEFAULT_MCP_REGISTRY: McpRegistry = {
  id: "official",
  name: "Official MCP Registry",
  baseUrl: process.env.MCP_REGISTRY_BASE_URL || "https://registry.modelcontextprotocol.io",
  description: "The public Model Context Protocol registry.",
  addedAt: "default",
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "mcp-registry"
}

function normalizeRegistry(input: Partial<McpRegistry>, existing?: McpRegistry | null): McpRegistry {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : existing?.name || "MCP Registry"
  const rawUrl = typeof input.baseUrl === "string" && input.baseUrl.trim() ? input.baseUrl.trim() : existing?.baseUrl || ""
  if (!rawUrl) throw new Error("registry URL is required")
  const parsed = new URL(rawUrl)
  parsed.pathname = parsed.pathname.replace(/\/+$/, "")
  parsed.search = ""
  parsed.hash = ""

  return {
    id: slugify(input.id || existing?.id || name),
    name,
    baseUrl: parsed.toString().replace(/\/+$/, ""),
    description: typeof input.description === "string" ? input.description.trim() : existing?.description || "",
    addedAt: existing?.addedAt || new Date().toISOString(),
  }
}

async function readStore(): Promise<StoreShape | null> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && Array.isArray(parsed.registries)
      ? parsed
      : null
  } catch {
    return null
  }
}

async function writeStore(store: StoreShape) {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 })
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export async function listMcpRegistries() {
  const store = await readStore()
  return store?.registries || [DEFAULT_MCP_REGISTRY]
}

export async function saveMcpRegistry(input: Partial<McpRegistry>) {
  const store = await readStore() || { registries: [DEFAULT_MCP_REGISTRY] }
  const id = slugify(input.id || input.name || "mcp-registry")
  const existing = store.registries.find((registry) => registry.id === id)
  const next = normalizeRegistry({ ...input, id }, existing)
  const filtered = store.registries.filter((registry) => registry.id !== next.id)
  store.registries = [next, ...filtered]
  await writeStore(store)
  return next
}

export async function deleteMcpRegistry(registryId: string) {
  const id = slugify(registryId)
  const store = await readStore() || { registries: [DEFAULT_MCP_REGISTRY] }
  store.registries = store.registries.filter((registry) => registry.id !== id)
  await writeStore(store)
  return { id }
}
