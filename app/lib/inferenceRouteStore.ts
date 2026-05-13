import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type VerifiedInferenceRoute = {
  id: string
  provider: string
  model: string
  label: string
  source: string
  lastVerifiedAt: string | null
}

type StoreShape = {
  routes: Record<string, VerifiedInferenceRoute>
}

const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const STORE_PATH = path.join(STORE_DIR, "inference-routes.json")

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function emptyStore(): StoreShape {
  return { routes: {} }
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && parsed.routes && typeof parsed.routes === "object"
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

export function inferenceRouteId(provider: string, model: string) {
  return `${provider}::${model}`
}

export function normalizeVerifiedInferenceRoute(input: Partial<VerifiedInferenceRoute> | null | undefined): VerifiedInferenceRoute | null {
  const provider = cleanString(input?.provider)
  const model = cleanString(input?.model)
  if (!provider || !model) return null

  return {
    id: inferenceRouteId(provider, model),
    provider,
    model,
    label: cleanString(input?.label) || "Verified route",
    source: cleanString(input?.source) || "saved",
    lastVerifiedAt: cleanString(input?.lastVerifiedAt) || null,
  }
}

export function mergeVerifiedInferenceRoutes(inputs: Array<Partial<VerifiedInferenceRoute> | null | undefined>) {
  const sourceRank: Record<string, number> = {
    sandbox: 1,
    saved: 2,
    system: 3,
    gateway: 4,
  }
  const routes = new Map<string, VerifiedInferenceRoute>()

  for (const input of inputs) {
    const route = normalizeVerifiedInferenceRoute(input)
    if (!route) continue

    const existing = routes.get(route.id)
    if (!existing) {
      routes.set(route.id, route)
      continue
    }

    const existingRank = sourceRank[existing.source] || 0
    const routeRank = sourceRank[route.source] || 0
    routes.set(route.id, routeRank >= existingRank ? { ...existing, ...route } : existing)
  }

  return Array.from(routes.values()).sort((first, second) => {
    const rankDelta = (sourceRank[second.source] || 0) - (sourceRank[first.source] || 0)
    if (rankDelta !== 0) return rankDelta
    return `${first.provider}/${first.model}`.localeCompare(`${second.provider}/${second.model}`)
  })
}

export async function listSavedVerifiedInferenceRoutes() {
  const store = await readStore()
  return mergeVerifiedInferenceRoutes(Object.values(store.routes))
}

export async function rememberVerifiedInferenceRoute(input: Partial<VerifiedInferenceRoute>) {
  const route = normalizeVerifiedInferenceRoute({
    ...input,
    lastVerifiedAt: input.lastVerifiedAt || new Date().toISOString(),
  })
  if (!route) return null

  const store = await readStore()
  store.routes[route.id] = route
  await writeStore(store)
  return route
}

export async function removeVerifiedInferenceRoutesForProvider(provider: string) {
  const cleanProvider = provider.trim()
  if (!cleanProvider) return

  const store = await readStore()
  for (const [id, route] of Object.entries(store.routes)) {
    if (route.provider === cleanProvider) delete store.routes[id]
  }
  await writeStore(store)
}
