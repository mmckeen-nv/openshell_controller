"use client"
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import ConfigurationPanel from './ConfigurationPanel'
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

type DrawerKey = 'operations' | 'files' | 'inference' | 'policy'
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
        className="flex w-full items-center justify-between gap-4 p-5 text-left"
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
        <div className="border-t border-[var(--border-subtle)] p-6">
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
  const [openDrawers, setOpenDrawers] = useState<Record<DrawerKey, boolean>>({
    operations: true,
    files: false,
    inference: false,
    policy: false,
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
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
              {isDestroyMode ? 'SELECT SANDBOX TO DESTROY' : 'ACTIVE SANDBOXES'}
            </h3>
            <span className="text-[10px] text-[var(--foreground-dim)] font-mono">
              REFRESH: 10s
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sandboxes.map((sandbox) => (
              <div
                key={sandbox.id}
                className={`p-4 rounded-sm text-left transition-all border-2 ${
                  isDestroyMode
                    ? 'border-[var(--status-stopped)] hover:bg-[var(--status-stopped-bg)]'
                    : selectedSandboxId === sandbox.id
                      ? 'bg-[var(--nvidia-green)] text-white border-[var(--nvidia-green)]'
                      : 'panel hover:border-[var(--nvidia-green)]'
                }`}
              >
                <button type="button" onClick={() => onSandboxSelect(sandbox.id)} className="w-full text-left">
                  <div className="flex items-center justify-between mb-3">
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
                      <span className={`text-sm font-mono font-semibold truncate ${
                        isDestroyMode ? 'text-[var(--status-stopped)]' : ''
                      }`}>
                        {sandbox.name}
                      </span>
                      {sandbox.isDefault ? (
                        <span className={`rounded-sm border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${selectedSandboxId === sandbox.id && !isDestroyMode ? 'border-black/30 text-black' : 'border-[var(--border-subtle)] text-[var(--foreground-dim)]'}`}>default</span>
                      ) : null}
                    </div>
                    <div className={`px-2 py-0.5 rounded-sm text-[10px] font-mono uppercase ${
                      isDestroyMode
                        ? 'bg-[var(--status-stopped)] text-white animate-pulse'
                        : sandbox.status === 'running' && sandbox.ready
                          ? 'bg-[var(--status-running)] text-white'
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
                      ['Namespace', sandbox.namespace, '120px'],
                      ['Host Alias', sandbox.sshHostAlias || 'N/A', '140px'],
                      ['Sandbox ID', sandbox.id, '140px'],
                    ] as Array<[string, string, string]>).map(([label, value, width]) => (
                      <div key={label} className="flex items-center justify-between gap-3">
                        <span className={`text-[10px] uppercase ${selectedSandboxId === sandbox.id && !isDestroyMode ? 'text-black' : 'text-[var(--foreground-dim)]'}`}>{label}</span>
                        <span className={`text-xs font-mono truncate ${selectedSandboxId === sandbox.id && !isDestroyMode ? 'text-black' : ''}`} style={{ maxWidth: width }} title={value}>{value}</span>
                      </div>
                    ))}
                  </div>
                </button>
                <div className="mt-3 pt-3 border-t border-black/10">
                  <select
                    value=""
                    disabled={grantingSandboxId === sandbox.id}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      const value = event.target.value
                      event.currentTarget.value = ''
                      resolvePermissionRequest(sandbox, 'approve', value)
                    }}
                    className={`w-full rounded-sm border px-3 py-2 text-xs font-mono uppercase tracking-wider focus:outline-none ${selectedSandboxId === sandbox.id && !isDestroyMode ? 'border-black/30 bg-white/30 text-black' : 'border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-[var(--foreground)]'}`}
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
                  <div className="flex items-center gap-3 flex-wrap">
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
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
                    >
                      Start OpenClaw Gateway Dashboard
                    </button>
                    <button
                      onClick={restartSandbox}
                      disabled={restartInProgress}
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)] disabled:opacity-50"
                    >
                      {restartInProgress ? 'Restarting Sandbox...' : 'Restart Sandbox'}
                    </button>
                    <button
                      onClick={async () => {
                        await onInventoryRefresh()
                      }}
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
                    >
                      Refresh Inventory
                    </button>
                    <span className="text-[10px] text-[var(--foreground-dim)] font-mono">
                      LIVE
                    </span>
                  </div>

                  {dashboardMessage && (
                    <div className="space-y-2">
                      {dashboardMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">{dashboardMessage}</div>}
                    </div>
                  )}

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
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
                title="Sandbox Policy"
                summary="Approve or reject network requests raised by the sandbox."
                open={openDrawers.policy}
                onToggle={() => toggleDrawer('policy')}
              >
                <div className="space-y-4">
                  {(() => {
                    const feed = permissionFeeds[selectedSandbox.id]
                    const pending = feed?.pending || []
                    if (pending.length === 0) {
                      return (
                        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                          No pending network permission requests for this sandbox.
                        </div>
                      )
                    }

                    return pending.map((request) => (
                      <div key={request.chunkId} className="rounded-sm border border-amber-400/60 bg-amber-400/10 p-4">
                        <div className="flex items-start justify-between gap-4">
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
                          <div className="flex shrink-0 items-center gap-2">
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
                    ))
                  })()}
                  <ConfigurationPanel sandboxId={selectedSandbox.id} mode="existing" embedded showHeader={false} />
                </div>
              </DrawerSection>
            </>
          )}
        </>
      )}
    </div>
  )
}
