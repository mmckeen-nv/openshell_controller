"use client"
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import ConfigurationPanel from './ConfigurationPanel'
import SandboxArchivePanel from './SandboxArchivePanel'
import SandboxFilesPanel from './SandboxFilesPanel'
import SandboxInferencePanel from './SandboxInferencePanel'
import { buildOperatorTerminalRoute } from '../lib/dashboardSession'
import type { NemoClawSummary, SandboxInventoryItem } from '../hooks/useSandboxInventory'

interface TelemetryData {
  cpu: number
  memory: number
  disk: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
  timestamp: string
}

interface SandboxListProps {
  sandboxes: SandboxInventoryItem[]
  nemoclaw: NemoClawSummary | null
  selectedSandboxId: string | null
  selectedSandbox: SandboxInventoryItem | null
  onSandboxSelect: (id: string | null) => void
  isDestroyMode: boolean
  onInventoryRefresh: () => Promise<SandboxInventoryItem[]>
  dashboardSessionId: string
}

type DrawerKey = 'operations' | 'files' | 'inference' | 'policy' | 'archive' | 'mcp'
type McpServerAccess = {
  id: string
  name: string
  command: string
  args: string[]
  enabled: boolean
  accessMode: 'disabled' | 'allow_all' | 'allow_only'
  allowedSandboxIds: string[]
}
type NetworkRuleRequest = {
  chunkId: string
  status: string
  rule: string
  binary: string
  confidence: string
  rationale: string
  endpoints: string[]
  binaries: string[]
}
type PermissionFeed = {
  latest?: { status?: string; chunkId?: string; error?: string } | null
  pending?: NetworkRuleRequest[]
  recent?: NetworkRuleRequest[]
  pendingCount?: number
  rejectedCount?: number
}

type DismissedPermissionAlerts = Record<string, string[]>

const DISMISSED_PERMISSION_ALERTS_STORAGE_KEY = 'openshell-control-dismissed-permission-alerts'
const DISMISS_PERMISSION_VALUE = '__dismiss_permission_alerts__'
const OPENCLAW_SANDBOX_LOGO = '/sandbox-logos/openclaw.svg'
const HERMES_SANDBOX_LOGO = '/sandbox-logos/hermes.png'

function renderDashboardTruthMessage(data: any) {
  if (data.reachable) return 'OpenClaw dashboard opened in a new tab.'
  return 'OpenClaw dashboard is not reachable from this host right now.'
}

function openDashboardUrl(url: string, openInNewTab: boolean) {
  if (openInNewTab) {
    window.open(url, '_blank', 'noopener,noreferrer')
  } else {
    window.location.href = url
  }
}

function displaySandboxAgent(agent?: string) {
  if (agent === 'hermes') return 'Hermes'
  return 'OpenClaw'
}

function CopyLinkButton({ label, copied, onClick }: { label: string; copied: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center w-9 px-2 rounded-sm border text-[var(--foreground-dim)] hover:border-[var(--nvidia-green)] hover:text-[var(--nvidia-green)] transition-colors ${copied ? 'border-[var(--nvidia-green)] text-[var(--nvidia-green)]' : 'border-[var(--border-subtle)]'}`}
    >
      {copied ? (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
          <path d="M5 12l5 5L20 7" />
        </svg>
      ) : (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="1" />
          <path d="M5 15V5a1 1 0 0 1 1-1h10" />
        </svg>
      )}
    </button>
  )
}

function SandboxTypeLogo({ agent }: { agent?: string }) {
  const isHermes = agent === 'hermes'
  const label = isHermes ? 'Hermes sandbox' : 'OpenClaw sandbox'
  const logoSrc = isHermes ? HERMES_SANDBOX_LOGO : OPENCLAW_SANDBOX_LOGO
  return (
    <span
      aria-label={label}
      title={label}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border shadow-inner ${
        isHermes
          ? 'border-sky-300/60 bg-sky-500/15'
          : 'border-rose-300/60 bg-rose-500/15'
      }`}
    >
      <span aria-hidden="true" className="h-6 w-6 bg-contain bg-center bg-no-repeat" style={{ backgroundImage: `url(${logoSrc})` }} />
    </span>
  )
}

function normalizeDismissedPermissionAlerts(value: unknown): DismissedPermissionAlerts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.entries(value as Record<string, unknown>).reduce<DismissedPermissionAlerts>((normalized, [sandboxId, chunks]) => {
    if (Array.isArray(chunks)) {
      const ids = chunks.filter((chunk): chunk is string => typeof chunk === 'string' && chunk.length > 0)
      if (ids.length > 0) normalized[sandboxId] = Array.from(new Set(ids))
    }
    return normalized
  }, {})
}

function loadDismissedPermissionAlerts(): DismissedPermissionAlerts {
  if (typeof window === 'undefined') return {}
  try {
    return normalizeDismissedPermissionAlerts(JSON.parse(window.localStorage.getItem(DISMISSED_PERMISSION_ALERTS_STORAGE_KEY) || '{}'))
  } catch {
    return {}
  }
}

function saveDismissedPermissionAlerts(alerts: DismissedPermissionAlerts) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(DISMISSED_PERMISSION_ALERTS_STORAGE_KEY, JSON.stringify(alerts))
}

function dismissedPermissionSet(alerts: DismissedPermissionAlerts, sandbox: SandboxInventoryItem) {
  return new Set([...(alerts[sandbox.id] || []), ...(alerts[sandbox.name] || [])])
}

function visiblePendingRequests(feed: PermissionFeed | undefined, sandbox: SandboxInventoryItem, alerts: DismissedPermissionAlerts) {
  const dismissed = dismissedPermissionSet(alerts, sandbox)
  return (feed?.pending || []).filter((request) => !request.chunkId || !dismissed.has(request.chunkId))
}

function permissionFeedNeedsAttention(feed: PermissionFeed | undefined, sandbox: SandboxInventoryItem, alerts: DismissedPermissionAlerts) {
  const latestStatus = feed?.latest?.status || ''
  const latestChunkId = feed?.latest?.chunkId || ''
  const dismissed = dismissedPermissionSet(alerts, sandbox)
  return Boolean(
    visiblePendingRequests(feed, sandbox, alerts).length > 0 ||
      (/pending|fail|error|unavailable/i.test(latestStatus) && (!latestChunkId || !dismissed.has(latestChunkId))),
  )
}

function DrawerSection({
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="panel overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 p-5 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--nvidia-green)] max-sm:p-4"
      >
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">{title}</h4>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">{summary}</p>
        </div>
        <svg
          className={`h-4 w-4 shrink-0 text-[var(--foreground-dim)] transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-[var(--border-subtle)] p-6 max-sm:p-4">
          {children}
        </div>
      )}
    </section>
  )
}

export default function SandboxList({
  sandboxes,
  nemoclaw: _nemoclaw,
  selectedSandboxId,
  selectedSandbox,
  onSandboxSelect,
  isDestroyMode,
  onInventoryRefresh,
  dashboardSessionId,
}: SandboxListProps) {
  const [dashboardMessage, setDashboardMessage] = useState<string>('')
const [restartInProgress, setRestartInProgress] = useState(false)
  const [permissionMessage, setPermissionMessage] = useState('')
  const [permissionFeeds, setPermissionFeeds] = useState<Record<string, PermissionFeed>>({})
  const [dismissedPermissionAlerts, setDismissedPermissionAlerts] = useState<DismissedPermissionAlerts>(() => loadDismissedPermissionAlerts())
  const [grantingSandboxId, setGrantingSandboxId] = useState<string | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerAccess[]>([])
  const [mcpMessage, setMcpMessage] = useState('')
  const [mcpUpdatingServerId, setMcpUpdatingServerId] = useState<string | null>(null)
  const [mcpSyncing, setMcpSyncing] = useState(false)
  const [openDrawers, setOpenDrawers] = useState<Record<DrawerKey, boolean>>({
    operations: true,
    files: false,
    inference: false,
    policy: false,
    archive: false,
    mcp: false,
  })
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    cpu: 0, memory: 0, disk: 0, timestamp: new Date().toISOString()
  })

  useEffect(() => {
    if (selectedSandboxId) {
      fetchTelemetry()
      const interval = setInterval(fetchTelemetry, 5000)
      return () => clearInterval(interval)
    }
  }, [selectedSandboxId])

  useEffect(() => {
    if (sandboxes.length === 0) {
      setPermissionFeeds({})
      return
    }

    let active = true
    const loadPermissionFeeds = async () => {
      const entries = await Promise.all(sandboxes.map(async (sandbox) => {
        try {
          const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/permissions`, { cache: 'no-store' })
          const data = await response.json()
          return [sandbox.id, response.ok ? data.feed : { rejectedCount: 1, latest: { status: 'Unavailable', error: data.error } }] as const
        } catch (error) {
          return [sandbox.id, { rejectedCount: 1, latest: { status: 'Unavailable', error: error instanceof Error ? error.message : 'Permission feed unavailable' } }] as const
        }
      }))
      if (active) setPermissionFeeds(Object.fromEntries(entries))
    }

    loadPermissionFeeds()
    const interval = window.setInterval(loadPermissionFeeds, 12000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [sandboxes])

  useEffect(() => {
    let active = true
    const loadMcpAccess = async () => {
      try {
        const response = await fetch('/api/mcp', { cache: 'no-store' })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to load MCP access')
        if (active) setMcpServers(Array.isArray(data.servers) ? data.servers : [])
      } catch (error) {
        if (active) {
          setMcpServers([])
          setMcpMessage(error instanceof Error ? error.message : 'Failed to load MCP access')
        }
      }
    }

    loadMcpAccess()
    const interval = window.setInterval(loadMcpAccess, 12000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  const fetchTelemetry = async () => {
    try {
      const response = await fetch('/api/telemetry/combined')
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
    }
  }

  const restartSandbox = async () => {
    if (!selectedSandbox || restartInProgress) return
    try {
      setRestartInProgress(true)
      setDashboardMessage(`Restarting sandbox ${selectedSandbox.name}...`)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(selectedSandbox.id)}/restart`, {
        method: 'POST',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || data.note || 'Failed to restart sandbox')
      setDashboardMessage(data.note || `Sandbox ${selectedSandbox.name} restarted.`)
      await onInventoryRefresh()
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : 'Failed to restart sandbox.')
    } finally {
      setRestartInProgress(false)
    }
  }

  const toggleDrawer = (key: DrawerKey) => {
    setOpenDrawers((current) => ({ ...current, [key]: !current[key] }))
  }

  const sandboxCanAccessMcpServer = (sandbox: SandboxInventoryItem, server: McpServerAccess) => {
    if (!server.enabled || server.accessMode === 'disabled') return false
    if (server.accessMode === 'allow_all') return true
    return server.allowedSandboxIds.includes(sandbox.id) || server.allowedSandboxIds.includes(sandbox.name)
  }

  const allowedMcpServersForSandbox = (sandbox: SandboxInventoryItem) => (
    mcpServers.filter((server) => sandboxCanAccessMcpServer(sandbox, server))
  )
  const selectedSandboxIsHermes = selectedSandbox?.agent === 'hermes'

  const connectToHermes = (sandbox: SandboxInventoryItem) => {
    const route = buildOperatorTerminalRoute({
      sandboxId: sandbox.name,
      dashboardSessionId,
      launch: 'hermes',
    })
    window.open(route, '_blank', 'noopener,noreferrer')
  }

  const [copiedLinkFor, setCopiedLinkFor] = useState<string | null>(null)
  const copyShareableLink = async (kind: 'hermes' | 'openclaw', sandbox: SandboxInventoryItem) => {
    const origin = typeof window !== 'undefined' ? window.location.origin : ''
    const url = kind === 'hermes'
      ? `${origin}/operator-terminal?sandboxId=${encodeURIComponent(sandbox.name)}&launch=hermes`
      : `${origin}/launch/dashboard?sandboxId=${encodeURIComponent(sandbox.name)}`
    try {
      await navigator.clipboard.writeText(url)
      setCopiedLinkFor(`${kind}:${sandbox.name}`)
      window.setTimeout(() => setCopiedLinkFor((current) => current === `${kind}:${sandbox.name}` ? null : current), 1800)
    } catch {
      setDashboardMessage(`Copy this link: ${url}`)
    }
  }

  const updateMcpServerAccess = async (
    server: McpServerAccess,
    body: Partial<Pick<McpServerAccess, 'enabled' | 'accessMode' | 'allowedSandboxIds'>>,
    success: string,
  ) => {
    try {
      setMcpUpdatingServerId(server.id)
      setMcpMessage('')
      const response = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-access', serverId: server.id, ...body }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to update MCP access')
      setMcpServers(Array.isArray(data.servers) ? data.servers : [])
      setMcpMessage(success)
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : 'Failed to update MCP access')
    } finally {
      setMcpUpdatingServerId(null)
    }
  }

  const syncMcpManifest = async (sandbox: SandboxInventoryItem) => {
    try {
      setMcpSyncing(true)
      setMcpMessage(`Issuing MCP broker config for ${sandbox.name}...`)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxName: sandbox.name }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to issue MCP broker config')
      setMcpMessage(data.note || 'MCP broker config issued.')
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : 'Failed to issue MCP broker config')
    } finally {
      setMcpSyncing(false)
    }
  }

  const enableMcpForSandbox = (sandbox: SandboxInventoryItem, server: McpServerAccess) => {
    const current = new Set(server.allowedSandboxIds)
    current.add(sandbox.id)
    return updateMcpServerAccess(server, {
      enabled: true,
      accessMode: server.accessMode === 'allow_all' ? 'allow_all' : 'allow_only',
      allowedSandboxIds: Array.from(current),
    }, `${server.name} enabled for ${sandbox.name}.`).then(() => syncMcpManifest(sandbox))
  }

  const revokeMcpForSandbox = (sandbox: SandboxInventoryItem, server: McpServerAccess) => {
    const current = new Set(server.allowedSandboxIds)
    current.delete(sandbox.id)
    current.delete(sandbox.name)
    if (server.accessMode === 'allow_all') {
      for (const item of sandboxes) {
        if (item.id !== sandbox.id) current.add(item.id)
      }
    }
    return updateMcpServerAccess(server, {
      accessMode: 'allow_only',
      allowedSandboxIds: Array.from(current),
    }, `${server.name} revoked from ${sandbox.name}.`).then(() => syncMcpManifest(sandbox))
  }

  const dismissPermissionAlerts = (sandbox: SandboxInventoryItem, chunkId?: string) => {
    const feed = permissionFeeds[sandbox.id]
    const visibleIds = visiblePendingRequests(feed, sandbox, dismissedPermissionAlerts)
      .map((request) => request.chunkId)
      .filter(Boolean)
    const idsToDismiss = chunkId ? [chunkId] : visibleIds

    if (idsToDismiss.length === 0) {
      setPermissionMessage(`No permission alerts to hide for ${sandbox.name}.`)
      return
    }

    setDismissedPermissionAlerts((current) => {
      const existing = new Set(current[sandbox.id] || [])
      for (const id of idsToDismiss) existing.add(id)
      const next = { ...current, [sandbox.id]: Array.from(existing) }
      saveDismissedPermissionAlerts(next)
      return next
    })
    setPermissionMessage(idsToDismiss.length === 1 ? `Permission alert hidden for ${sandbox.name}.` : `Permission alerts hidden for ${sandbox.name}.`)
  }

  const clearDismissedPermissionAlert = (sandbox: SandboxInventoryItem, chunkId: string) => {
    setDismissedPermissionAlerts((current) => {
      const existing = current[sandbox.id]
      if (!existing?.includes(chunkId)) return current
      const remaining = existing.filter((id) => id !== chunkId)
      const next = { ...current }
      if (remaining.length > 0) next[sandbox.id] = remaining
      else delete next[sandbox.id]
      saveDismissedPermissionAlerts(next)
      return next
    })
  }

  const resolvePermissionRequest = async (sandbox: SandboxInventoryItem, action: 'approve' | 'reject', chunkId: string) => {
    if (!chunkId) return
    try {
      setGrantingSandboxId(sandbox.id)
      setPermissionMessage(`${action === 'approve' ? 'Approving' : 'Rejecting'} network request for ${sandbox.name}...`)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, chunkId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to resolve permission request')
      if (data.result?.feed) {
        setPermissionFeeds((current) => ({ ...current, [sandbox.id]: data.result.feed }))
      }
      clearDismissedPermissionAlert(sandbox, chunkId)
      setPermissionMessage(data.note || `Network request ${action === 'approve' ? 'approved' : 'rejected'} for ${sandbox.name}.`)
    } catch (error) {
      setPermissionMessage(error instanceof Error ? error.message : 'Failed to resolve permission request')
    } finally {
      setGrantingSandboxId(null)
    }
  }

  return (
    <div className="space-y-6">
      {sandboxes.length === 0 ? (
        <div className="panel p-8 text-center">
          <svg className="w-12 h-12 mx-auto mb-4 text-[var(--foreground-dim)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <h3 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">No Sandboxes Detected</h3>
          <p className="text-xs text-[var(--foreground-dim)] mt-2">
            No live OpenShell sandboxes reported yet
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-end justify-between gap-4 max-sm:flex-col max-sm:items-start">
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--nvidia-green)]">
                Inventory
              </p>
              <h3 className="mt-1 text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
                {isDestroyMode ? 'SELECT SANDBOX TO DESTROY' : 'ACTIVE SANDBOXES'}
              </h3>
            </div>
            <span className="status-chip border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-2.5 py-1 text-[var(--foreground-dim)]">
              REFRESH 10s
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {sandboxes.map((sandbox) => (
              <div
                key={sandbox.id}
                className={`group overflow-hidden rounded border text-left transition-all duration-150 ${
                  isDestroyMode
                    ? 'border-[var(--status-stopped)] bg-[var(--status-stopped-bg)] hover:shadow-[0_18px_60px_rgba(220,38,38,0.16)]'
                    : selectedSandboxId === sandbox.id
                      ? 'border-[var(--nvidia-green)] bg-[var(--surface-hover)] shadow-[var(--shadow-glow)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-soft)] hover:-translate-y-0.5 hover:border-[var(--nvidia-green)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSandboxSelect(sandbox.id)}
                  className="w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--nvidia-green)]"
                  aria-pressed={selectedSandboxId === sandbox.id}
                >
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <SandboxTypeLogo agent={sandbox.agent} />
                      {(() => {
                        const feed = permissionFeeds[sandbox.id]
                        const visiblePending = visiblePendingRequests(feed, sandbox, dismissedPermissionAlerts)
                        const needsAttention = permissionFeedNeedsAttention(feed, sandbox, dismissedPermissionAlerts)
                        return needsAttention ? (
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-black animate-pulse" title={`Network permission: ${visiblePending.length} pending`}>
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M12 8v5m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                            </svg>
                          </span>
                        ) : (
                          <span className="h-2.5 w-2.5 rounded-full bg-[var(--status-running)]" title={`Policy status: ${feed?.latest?.status || 'ok'}`} />
                        )
                      })()}
                      <span className={`truncate font-mono text-sm font-semibold ${
                        isDestroyMode ? 'text-[var(--status-stopped)]' : 'text-[var(--foreground)]'
                      }`}>
                        {sandbox.name}
                      </span>
                      {sandbox.isDefault ? (
                        <span className="rounded-full border border-[var(--border-subtle)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--foreground-dim)]">default</span>
                      ) : null}
                      {(() => {
                        const hasMcpAccess = allowedMcpServersForSandbox(sandbox).length > 0
                        return (
                          <span
                            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border ${
                              hasMcpAccess
                                ? 'border-[var(--nvidia-green)] bg-[var(--status-running-bg)] text-[var(--nvidia-green)]'
                                : 'border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-[var(--foreground-dim)] opacity-55'
                            }`}
                            title={hasMcpAccess ? 'MCP access allowed' : 'No MCP access allowed'}
                            aria-label={hasMcpAccess ? 'MCP access allowed' : 'No MCP access allowed'}
                          >
                            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={2} d="M7 8h10M7 16h10M9 4h6a2 2 0 012 2v12a2 2 0 01-2 2H9a2 2 0 01-2-2V6a2 2 0 012-2z" />
                            </svg>
                          </span>
                        )
                      })()}
                    </div>
                    <div className={`status-chip shrink-0 px-2.5 py-1 ${
                      isDestroyMode
                        ? 'bg-[var(--status-stopped)] text-white animate-pulse'
                        : sandbox.status === 'running' && sandbox.ready
                          ? 'bg-[var(--status-running-bg)] text-[var(--status-running)] border border-[var(--status-running)]/40'
                        : sandbox.status === 'stopped'
                          ? 'bg-[var(--status-stopped)] text-white'
                        : sandbox.status === 'error'
                              ? 'bg-red-500 text-white'
                              : 'bg-[var(--status-pending)] text-white'
                    }`}>
                      {isDestroyMode ? 'DESTROY' : sandbox.status === 'running' && sandbox.ready ? 'RUNNING' : sandbox.status.toUpperCase()}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    {([
                      ['Agent', displaySandboxAgent(sandbox.agent), '120px'],
                      ['Attach Target', sandbox.ip, '180px'],
                      ['Namespace', sandbox.namespace, '120px'],
                      ['Host Alias', sandbox.sshHostAlias || 'N/A', '140px'],
                      ['Sandbox ID', sandbox.id, '140px'],
                    ] as Array<[string, string, string]>).map(([label, value, width]) => (
                      <div key={label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{label}</span>
                        <span className="text-xs font-mono truncate text-[var(--foreground)]" style={{ maxWidth: width }} title={value}>{value}</span>
                      </div>
                    ))}
                  </div>
                </button>
                <div className="border-t border-[var(--border-subtle)] p-3">
                  {(() => {
                    const feed = permissionFeeds[sandbox.id]
                    const visiblePending = visiblePendingRequests(feed, sandbox, dismissedPermissionAlerts)
                    return (
                      <select
                        value=""
                        disabled={grantingSandboxId === sandbox.id}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => {
                          const value = event.target.value
                          event.currentTarget.value = ''
                          if (value === DISMISS_PERMISSION_VALUE) {
                            dismissPermissionAlerts(sandbox)
                            return
                          }
                          resolvePermissionRequest(sandbox, 'approve', value)
                        }}
                        className="field-control w-full px-3 py-2 font-mono text-xs uppercase tracking-wider"
                      >
                        <option value="">
                          {grantingSandboxId === sandbox.id
                            ? 'Granting...'
                            : visiblePending.length > 0
                              ? 'Grant Permission'
                              : 'No Permission Requests'}
                        </option>
                        {visiblePending.length > 0 ? (
                          <option value={DISMISS_PERMISSION_VALUE}>Do Nothing</option>
                        ) : null}
                        {visiblePending.map((request) => (
                          <option key={request.chunkId} value={request.chunkId}>
                            {(request.endpoints[0] || request.rule || request.chunkId).slice(0, 46)}
                          </option>
                        ))}
                      </select>
                    )
                  })()}
                </div>
              </div>
            ))}
          </div>

          {permissionMessage && (
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
              {permissionMessage}
            </div>
          )}

          {!isDestroyMode && selectedSandbox && (
            <>
              <DrawerSection
                title={`${selectedSandbox.name} - Operations`}
                summary={selectedSandboxIsHermes ? "Terminal, restart, refresh, and live telemetry." : "Dashboard, terminal, restart, refresh, and live telemetry."}
                open={openDrawers.operations}
                onToggle={() => toggleDrawer('operations')}
              >
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center gap-3 max-sm:[&>button]:w-full">
                    {!selectedSandboxIsHermes ? (
                      <span className="inline-flex items-stretch gap-1">
                        <button
                          onClick={async () => {
                            try {
                              const searchParams = new URLSearchParams()
                              searchParams.set('sandboxId', selectedSandbox.name)
                              searchParams.set('inventoryCount', String(sandboxes.length))
                              const res = await fetch(`/api/openshell/dashboard/open?${searchParams.toString()}`)
                              const data = await res.json()
                              setDashboardMessage(renderDashboardTruthMessage(data))
                              if (data.reachable && data.launchUrl) {
                                openDashboardUrl(data.launchUrl, data.openInNewTab)
                              } else if (data.reachable && data.proxiedUrl) {
                                openDashboardUrl(data.proxiedUrl, data.openInNewTab)
                              } else if (data.reachable && data.dashboardUrl && !data.loopbackOnly) {
                                openDashboardUrl(data.dashboardUrl, data.openInNewTab)
                              }
                            } catch (error) {
                              setDashboardMessage('Failed to resolve OpenClaw Dashboard endpoint.')
                            }
                          }}
                          className="action-button px-3 py-2"
                        >
                          Start OpenClaw Gateway Dashboard
                        </button>
                        <CopyLinkButton
                          label={copiedLinkFor === `openclaw:${selectedSandbox.name}` ? 'Copied!' : 'Copy shareable dashboard link'}
                          copied={copiedLinkFor === `openclaw:${selectedSandbox.name}`}
                          onClick={() => copyShareableLink('openclaw', selectedSandbox)}
                        />
                      </span>
                    ) : (
                      <span className="inline-flex items-stretch gap-1">
                        <button
                          onClick={() => connectToHermes(selectedSandbox)}
                          className="action-button px-3 py-2"
                        >
                          Connect to Hermes
                        </button>
                        <CopyLinkButton
                          label={copiedLinkFor === `hermes:${selectedSandbox.name}` ? 'Copied!' : 'Copy shareable Hermes link'}
                          copied={copiedLinkFor === `hermes:${selectedSandbox.name}`}
                          onClick={() => copyShareableLink('hermes', selectedSandbox)}
                        />
                      </span>
                    )}
                    <button
                      onClick={restartSandbox}
                      disabled={restartInProgress}
                      className="action-button px-3 py-2"
                    >
                      {restartInProgress ? 'Restarting Sandbox...' : 'Restart Sandbox'}
                    </button>
                    <button
                      onClick={async () => {
                        await onInventoryRefresh()
                      }}
                      className="action-button px-3 py-2"
                    >
                      Refresh Inventory
                    </button>
                    <span className="status-chip border border-[var(--status-running)]/40 bg-[var(--status-running-bg)] px-2.5 py-1 text-[var(--status-running)]">
                      LIVE
                    </span>
                  </div>

                  {dashboardMessage && (
                    <div className="space-y-2">
                      {dashboardMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">{dashboardMessage}</div>}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">CPU</p>
                      <p className="text-xl font-mono text-[var(--nvidia-green)] mt-1">{telemetry.cpu.toFixed(1)}%</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">MEM</p>
                      <p className="text-xl font-mono text-[var(--nvidia-green)] mt-1">{telemetry.memory.toFixed(1)}%</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">DISK</p>
                      <p className="text-xl font-mono text-[var(--nvidia-green)] mt-1">{telemetry.disk.toFixed(1)}%</p>
                    </div>
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">UPDATED</p>
                      <p className="text-sm font-mono text-[var(--foreground)] mt-1">{new Date(telemetry.timestamp).toLocaleTimeString()}</p>
                    </div>
                  </div>
                </div>
              </DrawerSection>

              <DrawerSection
                title="File Transfer"
                summary="Upload files into the sandbox and download files back out."
                open={openDrawers.files}
                onToggle={() => toggleDrawer('files')}
              >
                <SandboxFilesPanel sandbox={selectedSandbox} embedded showHeader={false} />
              </DrawerSection>

              <DrawerSection
                title="Inference Routes"
                summary="Configure and apply provider/model routes for this sandbox."
                open={openDrawers.inference}
                onToggle={() => toggleDrawer('inference')}
              >
                <SandboxInferencePanel sandbox={selectedSandbox} embedded showHeader={false} />
              </DrawerSection>

              <DrawerSection
                title="Allowed MCP Server Access"
                summary="Enable, disable, or revoke MCP servers for this sandbox."
                open={openDrawers.mcp}
                onToggle={() => toggleDrawer('mcp')}
              >
                <div className="space-y-4">
                  <div className="flex items-center justify-between gap-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 max-sm:flex-col max-sm:items-start">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Sandbox Manifest</h4>
                      <p className="mt-1 text-xs text-[var(--foreground-dim)]">
                        Writes <span className="font-mono text-[var(--foreground)]">/sandbox/openshell_control_mcp.md</span> with broker URL and sandbox token only.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={mcpSyncing}
                      onClick={() => syncMcpManifest(selectedSandbox)}
                      className="action-button px-3 py-2 max-sm:w-full"
                    >
                      {mcpSyncing ? 'Issuing...' : 'Issue Broker Config'}
                    </button>
                  </div>
                  {mcpMessage && (
                    <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
                      {mcpMessage}
                    </div>
                  )}
                  {mcpServers.length === 0 ? (
                    <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                      No MCP servers are installed yet.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                      {mcpServers.map((server) => {
                        const hasAccess = sandboxCanAccessMcpServer(selectedSandbox, server)
                        const updating = mcpUpdatingServerId === server.id
                        return (
                          <div key={server.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <h4 className="truncate text-sm font-mono font-semibold text-[var(--foreground)]">{server.name}</h4>
                                <p className="mt-1 break-all font-mono text-[11px] text-[var(--foreground-dim)]">{server.command} {server.args.join(' ')}</p>
                              </div>
                              <span className={`status-chip px-2 py-1 ${hasAccess ? 'bg-[var(--status-running-bg)] text-[var(--status-running)]' : 'bg-[var(--status-pending-bg)] text-[var(--status-pending)]'}`}>
                                {hasAccess ? 'allowed' : 'blocked'}
                              </span>
                            </div>
                            <div className="mt-4 flex gap-2 max-sm:flex-col">
                              <button
                                type="button"
                                disabled={updating || hasAccess}
                                onClick={() => enableMcpForSandbox(selectedSandbox, server)}
                                className="action-button flex-1 px-3 py-2"
                              >
                                Enable
                              </button>
                              <button
                                type="button"
                                disabled={updating || !server.enabled}
                                onClick={() => updateMcpServerAccess(server, { enabled: false }, `${server.name} disabled globally.`)}
                                className="action-button flex-1 px-3 py-2"
                              >
                                Disable
                              </button>
                              <button
                                type="button"
                                disabled={updating || !hasAccess}
                                onClick={() => revokeMcpForSandbox(selectedSandbox, server)}
                                className="action-button flex-1 px-3 py-2"
                              >
                                Revoke
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </DrawerSection>

              <DrawerSection
                title="Sandbox Policy"
                summary="Approve or reject network requests raised by the sandbox."
                open={openDrawers.policy}
                onToggle={() => toggleDrawer('policy')}
              >
                <div className="space-y-4">
                  {(() => {
                    const feed = permissionFeeds[selectedSandbox.id]
                    const pending = visiblePendingRequests(feed, selectedSandbox, dismissedPermissionAlerts)
                    if (pending.length === 0) {
                      return (
                        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                          No pending network permission requests for this sandbox.
                        </div>
                      )
                    }

                    return pending.map((request) => (
                      <div key={request.chunkId} className="rounded-sm border border-amber-400/60 bg-amber-400/10 p-4">
                        <div className="flex items-start justify-between gap-4 max-md:flex-col">
                          <div className="min-w-0 space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-xs font-mono font-semibold text-[var(--foreground)]">
                                {request.endpoints.join(', ') || request.rule}
                              </span>
                              {request.confidence ? (
                                <span className="rounded-sm border border-[var(--border-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--foreground-dim)]">
                                  {request.confidence}
                                </span>
                              ) : null}
                            </div>
                            <p className="text-xs text-[var(--foreground-dim)]">{request.rationale || 'Sandbox requested a network policy rule.'}</p>
                            <p className="text-[10px] font-mono text-[var(--foreground-dim)]">
                              {request.binary || request.binaries.join(', ') || 'unknown binary'} / {request.chunkId}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2 max-md:w-full max-md:[&>button]:flex-1">
                            <button
                              type="button"
                              disabled={grantingSandboxId === selectedSandbox.id}
                              onClick={() => resolvePermissionRequest(selectedSandbox, 'approve', request.chunkId)}
                              className="rounded-sm border border-[var(--nvidia-green)] bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
                            >
                              Grant
                            </button>
                            <button
                              type="button"
                              disabled={grantingSandboxId === selectedSandbox.id}
                              onClick={() => resolvePermissionRequest(selectedSandbox, 'reject', request.chunkId)}
                              className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-[var(--foreground)] disabled:opacity-50"
                            >
                              Reject
                            </button>
                            <button
                              type="button"
                              disabled={grantingSandboxId === selectedSandbox.id}
                              onClick={() => dismissPermissionAlerts(selectedSandbox, request.chunkId)}
                              className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-[var(--foreground-dim)] disabled:opacity-50"
                            >
                              Do Nothing
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  })()}
                  <ConfigurationPanel sandboxId={selectedSandbox.id} mode="existing" embedded showHeader={false} />
                </div>
              </DrawerSection>

              <DrawerSection
                title="Backup / Restore"
                summary="Download a compressed archive or restore one into this sandbox."
                open={openDrawers.archive}
                onToggle={() => toggleDrawer('archive')}
              >
                <SandboxArchivePanel sandbox={selectedSandbox} onRestoreComplete={async () => { await onInventoryRefresh() }} />
              </DrawerSection>
            </>
          )}
        </>
      )}
    </div>
  )
}
