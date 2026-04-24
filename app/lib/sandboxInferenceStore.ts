import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export type SandboxInferenceConfig = {
  sandboxId: string
  provider: string
  primaryModel: string
  models: string[]
  updatedAt: string | null
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
  const models = Array.from(new Set([
    input?.primaryModel,
    ...(Array.isArray(input?.models) ? input.models : []),
  ].map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean)))

  return {
    sandboxId,
    provider: typeof input?.provider === "string" ? input.provider.trim() : "",
    primaryModel: models[0] || "",
    models,
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
