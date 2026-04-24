export type OpenClawInstanceRecord = {
  id: string
  label: string
  dashboardUrl: string
  terminalServerUrl?: string | null
  loopbackOnly: boolean
  default?: boolean
}

const DEFAULT_OPENCLAW_DASHBOARD_URL = 'http://127.0.0.1:18789/'
const DEFAULT_TERMINAL_SERVER_URL = process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011'
const DEFAULT_INSTANCE_ID = 'default'

const DEFAULT_INSTANCE: OpenClawInstanceRecord = {
  id: DEFAULT_INSTANCE_ID,
  label: 'Default local OpenClaw',
  dashboardUrl: process.env.OPENCLAW_DASHBOARD_URL || DEFAULT_OPENCLAW_DASHBOARD_URL,
  terminalServerUrl: DEFAULT_TERMINAL_SERVER_URL,
  loopbackOnly: true,
  default: true,
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function parseRegistryFromEnv(): OpenClawInstanceRecord[] {
  const raw = process.env.OPENCLAW_INSTANCE_REGISTRY_JSON?.trim()
  if (!raw) return [DEFAULT_INSTANCE]

  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [DEFAULT_INSTANCE]

    const normalized = parsed
      .map((entry): OpenClawInstanceRecord | null => {
        if (!entry || typeof entry !== 'object') return null

        const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : null
        const dashboardUrl = typeof entry.dashboardUrl === 'string' && entry.dashboardUrl.trim() ? entry.dashboardUrl.trim() : null
        if (!id || !dashboardUrl) return null

        return {
          id,
          label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
          dashboardUrl,
          terminalServerUrl: typeof entry.terminalServerUrl === 'string' && entry.terminalServerUrl.trim() ? entry.terminalServerUrl.trim() : DEFAULT_TERMINAL_SERVER_URL,
          loopbackOnly: parseBoolean(typeof entry.loopbackOnly === 'string' ? entry.loopbackOnly : undefined, entry.loopbackOnly ?? true),
          default: Boolean(entry.default),
        }
      })
      .filter((entry): entry is OpenClawInstanceRecord => Boolean(entry))

    if (normalized.length === 0) return [DEFAULT_INSTANCE]

    const hasDefault = normalized.some((entry) => entry.default || entry.id === DEFAULT_INSTANCE_ID)
    if (!hasDefault) {
      normalized.unshift(DEFAULT_INSTANCE)
    } else if (!normalized.some((entry) => entry.id === DEFAULT_INSTANCE_ID)) {
      normalized.unshift({ ...DEFAULT_INSTANCE, default: false })
    }

    return normalized
  } catch {
    return [DEFAULT_INSTANCE]
  }
}

const OPENCLAW_INSTANCE_REGISTRY = parseRegistryFromEnv()
const DEFAULT_SANDBOX_INSTANCE_MAP = process.env.MY_ASSISTANT_OPENCLAW_INSTANCE_ID?.trim()
  ? { 'my-assistant': process.env.MY_ASSISTANT_OPENCLAW_INSTANCE_ID.trim() }
  : { 'my-assistant': DEFAULT_INSTANCE_ID }

function parseSandboxInstanceMapFromEnv(): Record<string, string> {
  const raw = process.env.OPENCLAW_SANDBOX_INSTANCE_MAP_JSON?.trim()
  if (!raw) return DEFAULT_SANDBOX_INSTANCE_MAP

  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return DEFAULT_SANDBOX_INSTANCE_MAP
    }

    const normalized = Object.entries(parsed).reduce<Record<string, string>>((acc, [sandboxId, instanceId]) => {
      const normalizedSandboxId = typeof sandboxId === 'string' ? sandboxId.trim() : ''
      const normalizedInstanceId = typeof instanceId === 'string' ? instanceId.trim() : ''
      if (normalizedSandboxId && normalizedInstanceId) {
        acc[normalizedSandboxId] = normalizedInstanceId
      }
      return acc
    }, {})

    return Object.keys(normalized).length > 0
      ? { ...DEFAULT_SANDBOX_INSTANCE_MAP, ...normalized }
      : DEFAULT_SANDBOX_INSTANCE_MAP
  } catch {
    return DEFAULT_SANDBOX_INSTANCE_MAP
  }
}

const OPENCLAW_SANDBOX_INSTANCE_MAP = parseSandboxInstanceMapFromEnv()

export function listOpenClawInstances() {
  return OPENCLAW_INSTANCE_REGISTRY.map((entry) => ({ ...entry }))
}

export function getDefaultOpenClawInstance() {
  return OPENCLAW_INSTANCE_REGISTRY.find((entry) => entry.default) || OPENCLAW_INSTANCE_REGISTRY[0] || DEFAULT_INSTANCE
}

export function resolveOpenClawInstance(instanceId?: string | null) {
  const requested = typeof instanceId === 'string' ? instanceId.trim() : ''
  if (!requested) return getDefaultOpenClawInstance()
  return OPENCLAW_INSTANCE_REGISTRY.find((entry) => entry.id === requested) || getDefaultOpenClawInstance()
}

export function getOpenClawInstanceIdForSandbox(sandboxId?: string | null) {
  const requestedSandboxId = typeof sandboxId === 'string' ? sandboxId.trim() : ''
  if (!requestedSandboxId) return null
  return OPENCLAW_SANDBOX_INSTANCE_MAP[requestedSandboxId] || null
}

export function resolveOpenClawInstanceForSandbox(sandboxId?: string | null) {
  const mappedInstanceId = getOpenClawInstanceIdForSandbox(sandboxId)
  return mappedInstanceId ? resolveOpenClawInstance(mappedInstanceId) : getDefaultOpenClawInstance()
}
