export type OpenClawInstanceRecord = {
  id: string
  label: string
  dashboardUrl: string
  controlUiOrigin?: string | null
  terminalServerUrl?: string | null
  loopbackOnly: boolean
  default?: boolean
}

const DEFAULT_OPENCLAW_DASHBOARD_URL = 'http://127.0.0.1:18789/'
const DEFAULT_TERMINAL_SERVER_URL = process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011'
const DEFAULT_INSTANCE_ID = 'default'
const SANDBOX_INSTANCE_PREFIX = 'sandbox'
const SANDBOX_DASHBOARD_PORT_BASE = Number.parseInt(process.env.OPENCLAW_SANDBOX_DASHBOARD_PORT_BASE || '19000', 10)
const SANDBOX_DASHBOARD_PORT_RANGE = 2000

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
          controlUiOrigin: typeof entry.controlUiOrigin === 'string' && entry.controlUiOrigin.trim() ? entry.controlUiOrigin.trim() : null,
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
const DEFAULT_SANDBOX_INSTANCE_MAP: Record<string, string> = process.env.MY_ASSISTANT_OPENCLAW_INSTANCE_ID?.trim()
  ? { 'my-assistant': process.env.MY_ASSISTANT_OPENCLAW_INSTANCE_ID.trim() }
  : {}

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

function normalizeSandboxId(value?: string | null) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function hashSandboxId(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return Math.abs(hash)
}

export function getOpenClawDashboardPortForSandbox(sandboxId?: string | null) {
  const normalized = normalizeSandboxId(sandboxId)
  if (!normalized) return null
  return SANDBOX_DASHBOARD_PORT_BASE + (hashSandboxId(normalized) % SANDBOX_DASHBOARD_PORT_RANGE)
}

export function buildSandboxOpenClawInstanceId(sandboxId?: string | null) {
  const normalized = normalizeSandboxId(sandboxId)
  const port = getOpenClawDashboardPortForSandbox(normalized)
  if (!normalized || !port) return null
  return `${SANDBOX_INSTANCE_PREFIX}-${port}-${normalized}`
}

function parseSandboxOpenClawInstanceId(instanceId: string) {
  const match = instanceId.match(/^sandbox-(\d+)-(.+)$/)
  if (!match) return null
  const port = Number.parseInt(match[1], 10)
  const sandboxId = match[2]
  if (!Number.isFinite(port) || !sandboxId) return null
  return { port, sandboxId }
}

function resolveSandboxOpenClawInstance(instanceId: string): OpenClawInstanceRecord | null {
  const parsed = parseSandboxOpenClawInstanceId(instanceId)
  if (!parsed) return null
  return {
    id: instanceId,
    label: `OpenClaw for ${parsed.sandboxId}`,
    dashboardUrl: `http://127.0.0.1:${parsed.port}/`,
    controlUiOrigin: process.env.OPENCLAW_SANDBOX_CONTROL_UI_ORIGIN || 'http://127.0.0.1:18789',
    terminalServerUrl: DEFAULT_TERMINAL_SERVER_URL,
    loopbackOnly: true,
    default: false,
  }
}

export function listOpenClawInstances() {
  return OPENCLAW_INSTANCE_REGISTRY.map((entry) => ({ ...entry }))
}

export function getDefaultOpenClawInstance() {
  return OPENCLAW_INSTANCE_REGISTRY.find((entry) => entry.default) || OPENCLAW_INSTANCE_REGISTRY[0] || DEFAULT_INSTANCE
}

export function resolveOpenClawInstance(instanceId?: string | null) {
  const requested = typeof instanceId === 'string' ? instanceId.trim() : ''
  if (!requested) return getDefaultOpenClawInstance()
  const sandboxInstance = resolveSandboxOpenClawInstance(requested)
  if (sandboxInstance) return sandboxInstance
  return OPENCLAW_INSTANCE_REGISTRY.find((entry) => entry.id === requested) || getDefaultOpenClawInstance()
}

export function getOpenClawInstanceIdForSandbox(sandboxId?: string | null) {
  const requestedSandboxId = normalizeSandboxId(sandboxId)
  if (!requestedSandboxId) return null
  return OPENCLAW_SANDBOX_INSTANCE_MAP[requestedSandboxId] || buildSandboxOpenClawInstanceId(requestedSandboxId)
}

export function resolveOpenClawInstanceForSandbox(sandboxId?: string | null) {
  const mappedInstanceId = getOpenClawInstanceIdForSandbox(sandboxId)
  return mappedInstanceId ? resolveOpenClawInstance(mappedInstanceId) : getDefaultOpenClawInstance()
}
