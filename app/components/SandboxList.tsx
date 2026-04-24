"use client"
import { useEffect, useState } from 'react'
import ConfigurationPanel from './ConfigurationPanel'
import SandboxInferencePanel from './SandboxInferencePanel'
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

export default function SandboxList({
  sandboxes,
  nemoclaw: _nemoclaw,
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
                      onClick={() => {
                        const nextUrl = buildOperatorTerminalRoute({
                          sandboxId: selectedSandbox.id,
                          dashboardSessionId,
                        })
                        window.open(nextUrl, '_blank', 'noopener,noreferrer')
                      }}
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
                    >
                      Open Operator Terminal
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

              <SandboxInferencePanel sandbox={selectedSandbox} />

              <ConfigurationPanel sandboxId={selectedSandbox.id} mode="existing" />
            </>
          )}
        </>
      )}
    </div>
  )
}
