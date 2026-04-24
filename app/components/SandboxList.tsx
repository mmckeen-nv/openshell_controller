"use client"
import { useEffect, useState } from 'react'
import ConfigurationPanel from './ConfigurationPanel'
import type { NemoClawSummary, SandboxInventoryItem } from '../hooks/useSandboxInventory'
import { buildOperatorTerminalRoute } from '../lib/dashboardSession'

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
  dashboardSessionId: string
  selectedSandboxId: string | null
  selectedSandbox: SandboxInventoryItem | null
  onSandboxSelect: (id: string | null) => void
  isDestroyMode: boolean
  onInventoryRefresh: () => Promise<SandboxInventoryItem[]>
}

function renderDashboardTruthMessage(data: any) {
  const listenerSummary = data.listenerSummary ? `\nListener: ${data.listenerSummary}` : ''
  const showUpstreamSummary = !data.reachable || data.degraded || data.truthState !== 'verified'
  const upstreamSummary = showUpstreamSummary && (data.upstreamStatus || data.upstreamStatusText)
    ? `\nUpstream probe: ${data.upstreamStatus ?? 'no-status'} ${data.upstreamStatusText ?? ''}`.trimEnd()
    : ''
  const inventorySummary = typeof data.inventoryCount === 'number'
    ? `Inventory visibility: ${data.inventoryCount} live sandbox${data.inventoryCount === 1 ? '' : 'es'}.`
    : 'Inventory visibility: unknown.'
  const mappingSummary = data.sandboxId
    ? (data.authority?.usedMappedSandboxInstance
      ? `Sandbox ${data.sandboxId} resolved to OpenClaw instance ${data.instanceId} via bridge mapping (fallback-active).`
      : `Sandbox ${data.sandboxId} resolved to OpenClaw instance ${data.instanceId}.`)
    : `OpenClaw instance: ${data.instanceId}.`
  const reachabilitySummary = data.reachable
    ? `Dashboard reachability: reachable at ${data.dashboardUrl}.`
    : `Dashboard reachability: unreachable at ${data.dashboardUrl}.`

  if (data.degraded) {
    return `${inventorySummary} ${mappingSummary} ${reachabilitySummary} Degraded truth: the dashboard is reachable, but live OpenShell inventory is zero, so mapping alone does not prove the sandbox currently exists.${listenerSummary}${upstreamSummary}`
  }

  if (data.reachable) {
    return `${inventorySummary} ${mappingSummary} ${data.note || reachabilitySummary}`.trim()
  }

  return `${inventorySummary} ${mappingSummary} ${data.note || `OpenClaw Dashboard at ${data.dashboardUrl} is currently unreachable from this host.`}${listenerSummary}${upstreamSummary}`
}

export default function SandboxList({
  sandboxes,
  nemoclaw,
  dashboardSessionId,
  selectedSandboxId,
  selectedSandbox,
  onSandboxSelect,
  isDestroyMode,
  onInventoryRefresh,
}: SandboxListProps) {
  const [terminalMessage, setTerminalMessage] = useState<string>('')
  const [dashboardMessage, setDashboardMessage] = useState<string>('')
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

  const fetchTelemetry = async () => {
    try {
      const response = await fetch('/api/telemetry/combined')
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
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

          {!isDestroyMode && (
            <div className="panel p-4 space-y-2">
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Inventory Source</p>
                  <p className="text-sm font-mono text-[var(--foreground)] mt-1">Live OpenShell gateway inventory</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">NemoClaw Operator Surface</p>
                  <p className="text-sm font-mono text-[var(--foreground)] mt-1">
                    {nemoclaw?.available ? 'Local registry + services' : 'Unavailable'}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 pt-1">
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground-dim)]">
                  Inventory visibility: {sandboxes.length} live sandbox{sandboxes.length === 1 ? '' : 'es'}
                </div>
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground-dim)]">
                  Mapping truth: intent only, not proof of sandbox existence
                </div>
                <div className={`rounded-sm border px-3 py-2 text-xs font-mono ${sandboxes.length === 0 ? 'border-[var(--status-pending)] bg-[var(--status-pending-bg)] text-[var(--status-pending)]' : 'border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-[var(--foreground-dim)]'}`}>
                  {sandboxes.length === 0 ? 'Truth state: degraded / unverified' : 'Truth state: verified from live inventory'}
                </div>
              </div>
              <p className="text-xs text-[var(--foreground-dim)] font-mono">
                Dashboard session: {dashboardSessionId.slice(0, 8)}
              </p>
              {nemoclaw?.defaultSandboxNames?.length ? (
                <p className="text-xs text-[var(--foreground-dim)] font-mono">
                  Default sandbox marker: {nemoclaw.defaultSandboxNames.join(', ')}
                </p>
              ) : null}
              {nemoclaw?.serviceLines?.length ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                  {nemoclaw.serviceLines.slice(0, 4).map((line) => (
                    <div key={line} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground-dim)]" title={line}>
                      {line}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sandboxes.map((sandbox) => (
              <button
                key={sandbox.id}
                onClick={() => onSandboxSelect(sandbox.id)}
                className={`p-4 rounded-sm text-left transition-all border-2 ${
                  isDestroyMode
                    ? 'border-[var(--status-stopped)] hover:bg-[var(--status-stopped-bg)]'
                    : selectedSandboxId === sandbox.id
                      ? 'bg-[var(--nvidia-green)] text-white border-[var(--nvidia-green)]'
                      : 'panel hover:border-[var(--nvidia-green)]'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`text-sm font-mono font-semibold truncate ${
                      isDestroyMode ? 'text-[var(--status-stopped)]' : ''
                    }`}>
                      {sandbox.name}
                    </span>
                    {sandbox.isDefault ? (
                      <span className="rounded-sm border border-[var(--border-subtle)] px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-[var(--foreground-dim)]">default</span>
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
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--foreground-dim)] uppercase">Attach Target</span>
                    <span className="text-xs font-mono truncate max-w-[180px]" title={sandbox.ip}>{sandbox.ip}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--foreground-dim)] uppercase">Namespace</span>
                    <span className="text-xs font-mono truncate max-w-[120px]">{sandbox.namespace}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-[var(--foreground-dim)] uppercase">Host Alias</span>
                    <span className="text-xs font-mono truncate max-w-[140px]">{sandbox.sshHostAlias || 'N/A'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[10px] text-[var(--foreground-dim)] uppercase">Sandbox ID</span>
                    <span className="text-xs font-mono truncate max-w-[140px]" title={sandbox.id}>{sandbox.id}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {!isDestroyMode && selectedSandbox && (
            <>
              <div className="panel p-6">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border-subtle)] gap-4 flex-wrap">
                  <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
                    {selectedSandbox.name} — TELEMETRY
                  </h4>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={async () => {
                        try {
                          const searchParams = new URLSearchParams()
                          searchParams.set('sandboxId', selectedSandbox.id)
                          searchParams.set('inventoryCount', String(sandboxes.length))
                          const res = await fetch(`/api/openshell/dashboard/open?${searchParams.toString()}`)
                          const data = await res.json()
                          setDashboardMessage(renderDashboardTruthMessage(data))
                          if (data.reachable && data.launchUrl) {
                            window.location.href = data.launchUrl
                          } else if (data.reachable && data.proxiedUrl) {
                            window.location.href = data.proxiedUrl
                          } else if (data.reachable && data.dashboardUrl && !data.loopbackOnly) {
                            window.location.href = data.dashboardUrl
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
                      onClick={() => {
                        const nextUrl = buildOperatorTerminalRoute({
                          sandboxId: selectedSandbox.id,
                          dashboardSessionId,
                        })
                        window.open(nextUrl, '_blank', 'noopener,noreferrer')
                      }}
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
                    >
                      Open Operator Terminal Path
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
                </div>

                {(dashboardMessage || terminalMessage) && (
                  <div className="mb-4 space-y-2">
                    {dashboardMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">{dashboardMessage}</div>}
                    {terminalMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap font-mono">{terminalMessage}</div>}
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

              <ConfigurationPanel sandboxId={selectedSandbox.id} mode="existing" onInventoryRefresh={onInventoryRefresh} />
            </>
          )}
        </>
      )}
    </div>
  )
}
