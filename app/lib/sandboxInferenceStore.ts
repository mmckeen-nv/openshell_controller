import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type SandboxInferenceConfig = {
  sandboxId: string
  provider: string
  primaryModel: string
  models: string[]
  routes: SandboxInferenceRoute[]
  primaryRouteId: string
  updatedAt: string | null
}

export type SandboxInferenceRoute = {
  id: string
  provider: string
  model: string
  enabled: boolean
  label: string
}

type StoreShape = {
  sandboxes: Record<string, SandboxInferenceConfig>
}

const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const STORE_PATH = path.join(STORE_DIR, "sandbox-inference.json")

function emptyStore(): StoreShape {
  return { sandboxes: {} }
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" && parsed.sandboxes && typeof parsed.sandboxes === "object"
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

export function normalizeSandboxInferenceConfig(sandboxId: string, input?: Partial<SandboxInferenceConfig> | null): SandboxInferenceConfig {
  const legacyProvider = typeof input?.provider === "string" ? input.provider.trim() : ""
  const hasExplicitRoutes = Array.isArray(input?.routes) && input.routes.length > 0
  const legacyModels = Array.from(new Set([
    input?.primaryModel,
    ...(Array.isArray(input?.models) ? input.models : []),
  ].map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)))
  const rawRoutes: any[] = [
    ...(Array.isArray(input?.routes) ? input.routes : []),
    ...(hasExplicitRoutes ? [] : legacyModels.map((model) => ({ provider: legacyProvider, model, enabled: true, label: "" }))),
  ]
  const routeEntries: Array<[string, SandboxInferenceRoute]> = rawRoutes.map((route) => {
    const provider = typeof route?.provider === "string" ? route.provider.trim() : ""
    const model = typeof route?.model === "string" ? route.model.trim() : ""
    const id = `${provider}::${model}`
    return [id, {
      id,
      provider,
      model,
      enabled: route?.enabled !== false,
      label: typeof route?.label === "string" ? route.label.trim() : "",
    }] as [string, SandboxInferenceRoute]
  }).filter(([, route]) => route.provider && route.model)
  const routes = Array.from(new Map(routeEntries).values())
  const primaryRouteId = typeof input?.primaryRouteId === "string" && routes.some((route) => route.id === input.primaryRouteId)
    ? input.primaryRouteId
    : routes[0]?.id || ""
  const primaryRoute = routes.find((route) => route.id === primaryRouteId) || routes[0]

  return {
    sandboxId,
    provider: primaryRoute?.provider || legacyProvider,
    primaryModel: primaryRoute?.model || legacyModels[0] || "",
    models: routes.map((route) => route.model),
    routes,
    primaryRouteId,
    updatedAt: input?.updatedAt || null,
  }
}

export async function getSandboxInferenceConfig(sandboxId: string): Promise<SandboxInferenceConfig> {
  const store = await readStore()
  return normalizeSandboxInferenceConfig(sandboxId, store.sandboxes[sandboxId])
}

export async function saveSandboxInferenceConfig(sandboxId: string, input: Partial<SandboxInferenceConfig>): Promise<SandboxInferenceConfig> {
  const store = await readStore()
  const next = normalizeSandboxInferenceConfig(sandboxId, {
    ...input,
    updatedAt: new Date().toISOString(),
  })
  store.sandboxes[sandboxId] = next
  await writeStore(store)
  return next
}
