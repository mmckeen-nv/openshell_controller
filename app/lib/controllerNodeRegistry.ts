import { mkdir, readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"

export type ControllerNodeRecord = {
  id: string
  name: string
  host: string
  url: string
  role: "local" | "controller-node"
  status: "configured" | "local"
  updatedAt: string
}

type StoreShape = {
  nodes: Record<string, ControllerNodeRecord>
}

const STORE_DIR = process.env.OPENSHELL_CONTROL_STATE_DIR || path.join(process.cwd(), ".runtime")
const STORE_PATH = path.join(STORE_DIR, "controller-nodes.json")
const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i

function now() {
  return new Date().toISOString()
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128)
}

function localControllerNode(): ControllerNodeRecord {
  const port = process.env.NEXT_PUBLIC_DASHBOARD_PORT || process.env.PORT || "3000"
  const url = process.env.OPENSHELL_CONTROL_PUBLIC_URL || `http://localhost:${port}`
  return {
    id: "local",
    name: process.env.OPENSHELL_CONTROL_FRIENDLY_NAME || "Local Controller",
    host: hostname(),
    url,
    role: "local",
    status: "local",
    updatedAt: now(),
  }
}

function emptyStore(): StoreShape {
  return { nodes: {} }
}

function normalizeNode(input: Partial<ControllerNodeRecord>, existing?: ControllerNodeRecord | null): ControllerNodeRecord {
  const host = text(input.host, existing?.host || "")
  const url = text(input.url, existing?.url || (host ? `http://${host}:3000` : ""))
  const id = slugify(text(input.id, existing?.id || host || url))
  if (!id || !SAFE_ID.test(id)) throw new Error("controller node id is invalid")
  if (!host) throw new Error("controller node host is required")
  if (!url) throw new Error("controller node url is required")

  return {
    id,
    name: text(input.name, existing?.name || host),
    host,
    url,
    role: input.role === "local" ? "local" : "controller-node",
    status: input.status === "local" ? "local" : "configured",
    updatedAt: now(),
  }
}

function parseEnvNodes() {
  const raw = process.env.OPENSHELL_CONTROLLER_NODES_JSON || process.env.OPENCLAW_INSTANCE_REGISTRY_JSON
  if (!raw?.trim()) return []

  try {
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.nodes) ? parsed.nodes : []
    return entries
      .map((entry: unknown) => {
        if (!entry || typeof entry !== "object") return null
        const record = entry as Record<string, unknown>
        const url = text(record.url, text(record.controlUiOrigin, text(record.dashboardUrl)))
        const host = text(record.host, url ? new URL(url).hostname : "")
        if (!host || !url) return null
        return normalizeNode({
          id: text(record.id, host),
          name: text(record.name, text(record.label, host)),
          host,
          url,
          role: record.role === "local" ? "local" : "controller-node",
        })
      })
      .filter((entry: ControllerNodeRecord | null): entry is ControllerNodeRecord => Boolean(entry))
  } catch {
    return []
  }
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || !parsed.nodes || typeof parsed.nodes !== "object") return emptyStore()
    return { nodes: parsed.nodes }
  } catch {
    return emptyStore()
  }
}

async function writeStore(store: StoreShape) {
  await mkdir(STORE_DIR, { recursive: true, mode: 0o700 })
  await writeFile(STORE_PATH, JSON.stringify(store, null, 2), { mode: 0o600 })
}

export async function listControllerNodes() {
  const store = await readStore()
  const merged = new Map<string, ControllerNodeRecord>()
  const local = localControllerNode()
  merged.set(local.id, { ...local, ...store.nodes[local.id], role: "local", status: "local" })

  for (const node of parseEnvNodes()) {
    merged.set(node.id, { ...node, ...store.nodes[node.id] })
  }
  for (const node of Object.values(store.nodes)) {
    merged.set(node.id, node)
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.role === "local") return -1
    if (b.role === "local") return 1
    return a.name.localeCompare(b.name)
  })
}

export async function upsertControllerNode(input: Partial<ControllerNodeRecord>) {
  const store = await readStore()
  const id = slugify(text(input.id, input.host || input.url || ""))
  const existing = id ? store.nodes[id] : null
  const node = normalizeNode(input, existing)
  store.nodes[node.id] = node
  await writeStore(store)
  return node
}

export async function renameControllerNode(nodeId: string, name: string) {
  const nodes = await listControllerNodes()
  const existing = nodes.find((node) => node.id === slugify(nodeId))
  if (!existing) throw new Error("controller node was not found")
  return upsertControllerNode({ ...existing, name })
}
