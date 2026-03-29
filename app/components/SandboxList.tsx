"use client"
import { useState, useEffect } from 'react'
import ConfigurationPanel from './ConfigurationPanel'

interface Sandbox {
  id: string
  name: string
  namespace: string
  ip: string
  status: 'running' | 'pending' | 'stopped' | 'unknown'
  ready: boolean
}

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
  selectedSandbox: string | null
  onSandboxSelect: (id: string | null) => void
  isDestroyMode: boolean
}

export default function SandboxList({
  selectedSandbox,
  onSandboxSelect,
  isDestroyMode
}: SandboxListProps) {
  const [terminalMessage, setTerminalMessage] = useState<string>('')
  const [dashboardMessage, setDashboardMessage] = useState<string>('')
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    cpu: 0, memory: 0, disk: 0, timestamp: new Date().toISOString()
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchSandboxes()
    const interval = setInterval(fetchSandboxes, 10000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (selectedSandbox) {
      fetchTelemetry()
      const interval = setInterval(fetchTelemetry, 5000)
      return () => clearInterval(interval)
    }
  }, [selectedSandbox])

  const fetchSandboxes = async () => {
    try {
      const response = await fetch('/api/telemetry/real')
      const data = await response.json()

      const sandboxList = (data.pods?.items || [])
        .filter((pod: any) => pod.metadata?.namespace === 'agent-sandbox-system')
        .map((pod: any) => ({
          id: pod.metadata?.name || 'unknown',
          name: pod.metadata?.name || 'Unknown Sandbox',
          namespace: pod.metadata?.namespace || 'unknown',
          ip: pod.status?.podIP || 'N/A',
          status: pod.status?.phase === 'Running' ? 'running' : 
                  pod.status?.phase === 'Pending' ? 'pending' : 
                  pod.status?.phase === 'Stopped' ? 'stopped' : 'unknown' as const,
          ready: pod.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True'
        }))

      setSandboxes(sandboxList)
      setLoading(false)
    } catch (error) {
      console.error('Error fetching sandboxes:', error)
      setLoading(false)
    }
  }

  const fetchTelemetry = async () => {
    try {
      const response = await fetch('/api/telemetry/combined')
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-xs text-[var(--foreground-dim)] font-mono uppercase tracking-wider">
          INITIALIZING...
        </div>
      </div>
    )
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
            No sandboxes running in agent-sandbox-system namespace
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
                    : selectedSandbox === sandbox.id
                      ? 'bg-[var(--nvidia-green)] text-white border-[var(--nvidia-green)]'
                      : 'panel hover:border-[var(--nvidia-green)]'
                }`}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-sm font-mono font-semibold truncate ${
                    isDestroyMode ? 'text-[var(--status-stopped)]' : ''
                  }`}>
                    {sandbox.name}
                  </span>
                  <div className={`px-2 py-0.5 rounded-sm text-[10px] font-mono uppercase ${
                    isDestroyMode
                      ? 'bg-[var(--status-stopped)] text-white animate-pulse'
                      : sandbox.status === 'running' && sandbox.ready
                        ? 'bg-[var(--status-running)] text-white'
                        : 'bg-[var(--status-pending)] text-white'
                  }`}>
                    {isDestroyMode ? 'DESTROY' : sandbox.status === 'running' && sandbox.ready ? 'RUNNING' : 'PENDING'}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--foreground-dim)] uppercase">IP Address</span>
                    <span className="text-xs font-mono">{sandbox.ip}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-[var(--foreground-dim)] uppercase">Namespace</span>
                    <span className="text-xs font-mono truncate max-w-[120px]">{sandbox.namespace}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/* Selected Sandbox Details - Technical Data Panel */}
          {!isDestroyMode && selectedSandbox && (
            <>
              <div className="panel p-6">
                <div className="flex items-center justify-between mb-6 pb-4 border-b border-[var(--border-subtle)] gap-4 flex-wrap">
                  <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
                    {sandboxes.find(s => s.id === selectedSandbox)?.name} — TELEMETRY
                  </h4>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch('/api/openshell/dashboard')
                          const data = await res.json()
                          setDashboardMessage(data.loopbackOnly
                            ? `OpenClaw Dashboard detected at ${data.dashboardUrl}. It is loopback-only, so the next step is adding a proxy/open-in-new-tab bridge.`
                            : `OpenClaw Dashboard: ${data.dashboardUrl}`)
                        } catch (error) {
                          setDashboardMessage('Failed to resolve OpenClaw Dashboard endpoint.')
                        }
                      }}
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
                    >
                      Start OpenClaw Gateway Dashboard
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const res = await fetch(`/api/openshell/terminal?sandboxId=${encodeURIComponent(selectedSandbox)}`)
                          const data = await res.json()
                          setTerminalMessage(data.note || 'Terminal attach route reached.')
                        } catch (error) {
                          setTerminalMessage('Failed to attach to OpenShell terminal.')
                        }
                      }}
                      className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]"
                    >
                      Attach to OpenShell Terminal
                    </button>
                    <span className="text-[10px] text-[var(--foreground-dim)] font-mono">
                      LIVE
                    </span>
                  </div>
                </div>
                
                {(dashboardMessage || terminalMessage) && (
                  <div className="mb-4 space-y-2">
                    {dashboardMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">{dashboardMessage}</div>}
                    {terminalMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-xs text-[var(--foreground-dim)]">{terminalMessage}</div>}
                  </div>
                )}

                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="metric p-4">
                    <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">CPU</p>
                    <p className="text-2xl font-mono text-[var(--nvidia-green)] mt-1">
                      {telemetry.cpu.toFixed(1)}%
                    </p>
                  </div>
                  <div className="metric p-4">
                    <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">MEMORY</p>
                    <p className="text-2xl font-mono text-[var(--nvidia-green)] mt-1">
                      {telemetry.memory.toFixed(1)}%
                    </p>
                  </div>
                  <div className="metric p-4">
                    <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">DISK</p>
                    <p className="text-2xl font-mono text-[var(--nvidia-green)] mt-1">
                      {telemetry.disk.toFixed(1)}%
                    </p>
                  </div>
                  {telemetry.gpuTemperature && (
                    <div className="metric p-4">
                      <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">GPU TEMP</p>
                      <p className="text-2xl font-mono text-[var(--nvidia-green)] mt-1">
                        {telemetry.gpuTemperature.toFixed(1)}°C
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <ConfigurationPanel sandboxId={selectedSandbox} mode="existing" />
            </>
          )}
        </>
      )}
    </div>
  )
}
