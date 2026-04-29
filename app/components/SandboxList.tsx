"use client"
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import ConfigurationPanel from './ConfigurationPanel'
import SandboxArchivePanel from './SandboxArchivePanel'
import SandboxFilesPanel from './SandboxFilesPanel'
import SandboxInferencePanel from './SandboxInferencePanel'
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
}: SandboxListProps) {
  const [dashboardMessage, setDashboardMessage] = useState<string>('')
  const [restartInProgress, setRestartInProgress] = useState(false)
  const [permissionMessage, setPermissionMessage] = useState('')
  const [permissionFeeds, setPermissionFeeds] = useState<Record<string, PermissionFeed>>({})
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

  const loadPermissionFeed = useCallback(async (sandbox: SandboxInventoryItem) => {
    try {
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/permissions`, { cache: 'no-store' })
      const data = await response.json()
      const feed = response.ok ? data.feed : { rejectedCount: 1, latest: { status: 'Unavailable', error: data.error } }
      setPermissionFeeds((current) => ({ ...current, [sandbox.id]: feed }))
    } catch (error) {
      setPermissionFeeds((current) => ({
        ...current,
        [sandbox.id]: { rejectedCount: 1, latest: { status: 'Unavailable', error: error instanceof Error ? error.message : 'Permission feed unavailable' } },
      }))
    }
  }, [])

  useEffect(() => {
    if (sandboxes.length === 0) {
      setPermissionFeeds({})
      return
    }
    setPermissionFeeds((current) => Object.fromEntries(
      Object.entries(current).filter(([sandboxId]) => sandboxes.some((sandbox) => sandbox.id === sandboxId)),
    ))
  }, [sandboxes])

  useEffect(() => {
    if (!selectedSandbox || !openDrawers.policy || permissionFeeds[selectedSandbox.id]) return
    loadPermissionFeed(selectedSandbox)
  }, [loadPermissionFeed, openDrawers.policy, permissionFeeds, selectedSandbox])

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

  const restartSandboxRuntime = async () => {
    if (!selectedSandbox || restartInProgress) return
    try {
      setRestartInProgress(true)
      setDashboardMessage(`Restarting OpenClaw runtime for ${selectedSandbox.name}...`)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(selectedSandbox.id)}/restart`, {
        method: 'POST',
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || data.note || 'Failed to restart OpenClaw runtime')
      setDashboardMessage(data.note || `OpenClaw runtime restarted for ${selectedSandbox.name}.`)
      await onInventoryRefresh()
    } catch (error) {
      setDashboardMessage(error instanceof Error ? error.message : 'Failed to restart OpenClaw runtime.')
    } finally {
      setRestartInProgress(false)
    }
  }

  const toggleDrawer = (key: DrawerKey) => {
    const opening = !openDrawers[key]
    setOpenDrawers((current) => ({ ...current, [key]: !current[key] }))
    if (key === 'policy' && opening && selectedSandbox) {
      loadPermissionFeed(selectedSandbox)
    }
  }

  const sandboxCanAccessMcpServer = (sandbox: SandboxInventoryItem, server: McpServerAccess) => {
    if (!server.enabled || server.accessMode === 'disabled') return false
    if (server.accessMode === 'allow_all') return true
    return server.allowedSandboxIds.includes(sandbox.id) || server.allowedSandboxIds.includes(sandbox.name)
  }

  const allowedMcpServersForSandbox = (sandbox: SandboxInventoryItem) => (
    mcpServers.filter((server) => sandboxCanAccessMcpServer(sandbox, server))
  )

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

  const syncMcpManifest = async (sandbox: SandboxInventoryItem, action: 'sync' | 'revoke' = 'sync') => {
    try {
      setMcpSyncing(true)
      setMcpMessage(action === 'revoke' ? `Revoking MCP broker config for ${sandbox.name}...` : `Issuing MCP broker config for ${sandbox.name}...`)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxName: sandbox.name, action }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to update MCP broker config')
      const networkNote = data.network?.approved?.length
        ? ` Approved ${data.network.approved.length} broker network rule${data.network.approved.length === 1 ? '' : 's'}.`
        : data.network?.rejected?.length
          ? ` Removed ${data.network.rejected.length} broker network rule${data.network.rejected.length === 1 ? '' : 's'}.`
          : ''
      setMcpMessage(`${data.note || 'MCP broker config updated.'}${networkNote}`)
    } catch (error) {
      setMcpMessage(error instanceof Error ? error.message : 'Failed to update MCP broker config')
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
    }, `${server.name} enabled for ${sandbox.name}.`)
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
    }, `${server.name} revoked from ${sandbox.name}.`)
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
          <aside className="border border-[var(--border-subtle)] bg-[var(--background-secondary)]/95 shadow-[12px_0_40px_rgba(0,0,0,0.2)] backdrop-blur lg:fixed lg:left-64 lg:top-0 lg:z-10 lg:h-screen lg:w-80 lg:border-y-0 lg:border-l-0 max-lg:rounded max-lg:shadow-[var(--shadow-soft)]">
            <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] p-4">
              <div className="min-w-0">
                <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--nvidia-green)]">
                  Inventory
                </p>
                <h3 className="mt-1 text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
                  {isDestroyMode ? 'Select To Destroy' : 'Sandboxes'}
                </h3>
                <p className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                  {sandboxes.length} total / {sandboxes.filter((sandbox) => sandbox.ready).length} ready
                </p>
              </div>
              <span className="status-chip shrink-0 border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-2.5 py-1 text-[var(--foreground-dim)]">
                10s
              </span>
            </div>

            <div className="max-h-[calc(100vh-5.5rem)] space-y-2 overflow-y-auto p-3 max-lg:max-h-[22rem]">
            {sandboxes.map((sandbox) => (
              <div
                key={sandbox.id}
                className={`group overflow-hidden rounded border text-left transition-all duration-150 ${
                  isDestroyMode
                    ? 'border-[var(--status-stopped)] bg-[var(--status-stopped-bg)] hover:shadow-[0_18px_60px_rgba(220,38,38,0.16)]'
                    : selectedSandboxId === sandbox.id
                      ? 'border-[var(--nvidia-green)] bg-[var(--surface-hover)] shadow-[var(--shadow-glow)]'
                      : 'border-[var(--border-subtle)] bg-[var(--surface-raised)] shadow-[var(--shadow-soft)] hover:border-[var(--nvidia-green)] hover:bg-[var(--surface-hover)]'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSandboxSelect(sandbox.id)}
                  className="w-full p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--nvidia-green)]"
                  aria-pressed={selectedSandboxId === sandbox.id}
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      {(() => {
                        const feed = permissionFeeds[sandbox.id]
                        const needsAttention = Boolean((feed?.pendingCount || 0) > 0 || /pending|fail|error|unavailable/i.test(feed?.latest?.status || ''))
                        return needsAttention ? (
                          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-400 text-black animate-pulse" title={`Network permission: ${feed?.pendingCount || 0} pending`}>
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

                  <div className="space-y-1">
                    {([
                      ['Attach Target', sandbox.ip, '180px'],
                      ['Sandbox ID', sandbox.id, '140px'],
                    ] as Array<[string, string, string]>).map(([label, value, width]) => (
                      <div key={label} className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-2">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{label}</span>
                        <span className="text-xs font-mono truncate text-[var(--foreground)]" style={{ maxWidth: width }} title={value}>{value}</span>
                      </div>
                    ))}
                  </div>
                </button>
                <div className="border-t border-[var(--border-subtle)] p-2">
                  <select
                    value=""
                    disabled={grantingSandboxId === sandbox.id}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const value = event.target.value
                      event.currentTarget.value = ''
                      resolvePermissionRequest(sandbox, 'approve', value)
                    }}
                    className="field-control w-full px-2 py-2 font-mono text-[11px] uppercase tracking-wider"
                  >
                    <option value="">
                      {grantingSandboxId === sandbox.id
                        ? 'Granting...'
                        : (permissionFeeds[sandbox.id]?.pendingCount || 0) > 0
                          ? 'Grant Permission'
                          : 'No Permission Requests'}
                    </option>
                    {(permissionFeeds[sandbox.id]?.pending || []).map((request) => (
                      <option key={request.chunkId} value={request.chunkId}>
                        {(request.endpoints[0] || request.rule || request.chunkId).slice(0, 46)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
            </div>
          </aside>

          {permissionMessage && (
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">
              {permissionMessage}
            </div>
          )}

          {!isDestroyMode && selectedSandbox && (
            <>
              <DrawerSection
                title={`${selectedSandbox.name} - Operations`}
                summary="Dashboard, terminal, restart, refresh, and live telemetry."
                open={openDrawers.operations}
                onToggle={() => toggleDrawer('operations')}
              >
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center gap-3 max-sm:[&>button]:w-full">
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
                    <button
                      onClick={restartSandboxRuntime}
                      disabled={restartInProgress}
                      className="action-button px-3 py-2"
                    >
                      {restartInProgress ? 'Restarting Runtime...' : 'Restart OpenClaw Runtime'}
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
                        Writes <span className="font-mono text-[var(--foreground)]">/sandbox/openshell_control_mcp.md</span> and configures OpenClaw to use the broker MCP endpoint.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={mcpSyncing}
                      onClick={() => syncMcpManifest(selectedSandbox, allowedMcpServersForSandbox(selectedSandbox).length > 0 ? 'sync' : 'revoke')}
                      className="action-button px-3 py-2 max-sm:w-full"
                    >
                      {mcpSyncing ? 'Updating...' : 'Sync Broker Config'}
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
                  <div className="flex items-center justify-between gap-4 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 max-sm:flex-col max-sm:items-start">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Network Permission Feed</h4>
                      <p className="mt-1 text-xs text-[var(--foreground-dim)]">Loaded on demand for the selected sandbox to avoid background permission polling.</p>
                    </div>
                    <button
                      type="button"
                      disabled={grantingSandboxId === selectedSandbox.id}
                      onClick={() => loadPermissionFeed(selectedSandbox)}
                      className="action-button px-3 py-2 max-sm:w-full"
                    >
                      Refresh Requests
                    </button>
                  </div>
	                  {(() => {
	                    const feed = permissionFeeds[selectedSandbox.id]
	                    const pending = feed?.pending || []
	                    const recent = feed?.recent || []
	                    const recentRules = recent.filter((request) => !pending.some((pendingRequest) => pendingRequest.chunkId === request.chunkId))
	                    const renderRecentRules = () => recentRules.length > 0 && (
	                      <div className="space-y-3">
	                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--foreground-dim)]">Recent Network Rules</h4>
	                        <div className="max-h-[26rem] space-y-3 overflow-y-auto pr-1">
	                          {recentRules.map((request) => {
	                            const approved = /approved/i.test(request.status)
	                            const rejected = /rejected/i.test(request.status)
	                            return (
	                              <div key={`${request.status}-${request.chunkId}`} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
	                                <div className="flex items-start justify-between gap-4 max-md:flex-col">
	                                  <div className="min-w-0 space-y-2">
	                                    <div className="flex flex-wrap items-center gap-2">
	                                      <span className="break-all text-xs font-mono font-semibold text-[var(--foreground)]">
	                                        {request.endpoints.join(', ') || request.rule}
	                                      </span>
	                                      <span className={`status-chip px-2 py-1 ${approved ? 'bg-[var(--status-running-bg)] text-[var(--status-running)]' : rejected ? 'bg-[var(--status-stopped)] text-white' : 'bg-[var(--status-pending-bg)] text-[var(--status-pending)]'}`}>
	                                        {request.status || 'unknown'}
	                                      </span>
	                                    </div>
	                                    <p className="text-xs text-[var(--foreground-dim)]">{request.rationale || 'Sandbox network rule.'}</p>
	                                    <p className="text-[10px] font-mono text-[var(--foreground-dim)]">
	                                      {request.binary || request.binaries.join(', ') || 'unknown binary'} / {request.chunkId}
	                                    </p>
	                                  </div>
	                                  {(approved || rejected) && (
	                                    <button
	                                      type="button"
	                                      disabled={grantingSandboxId === selectedSandbox.id}
	                                      onClick={() => resolvePermissionRequest(selectedSandbox, approved ? 'reject' : 'approve', request.chunkId)}
	                                      className={`${rejected ? 'rounded-sm border border-[var(--nvidia-green)] bg-[var(--nvidia-green)] text-black' : 'rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] text-[var(--foreground)]'} px-3 py-2 text-xs font-mono uppercase tracking-wider disabled:opacity-50 max-md:w-full`}
	                                    >
	                                      {approved ? 'Revoke' : 'Approve'}
	                                    </button>
	                                  )}
	                                </div>
	                              </div>
	                            )
	                          })}
	                        </div>
	                      </div>
	                    )
	                    if (pending.length === 0) {
	                      return (
	                        <>
	                          <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
	                            No pending network permission requests for this sandbox.
	                          </div>
	                          {renderRecentRules()}
	                        </>
	                      )
	                    }

                    return (
                      <div className="space-y-3">
                        {pending.map((request) => (
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
                              </div>
                            </div>
                          </div>
                        ))}
	                        {renderRecentRules()}
	                      </div>
	                    )
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
