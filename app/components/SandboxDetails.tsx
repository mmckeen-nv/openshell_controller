"use client"
import { useState, useEffect, useCallback } from 'react'
import CompactGauge from './CompactGauge'

interface TelemetryData {
  cpu: number
  memory: number
  disk: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
  timestamp?: string
}

interface SandboxConfig {
  name: string
  description: string
  enabled: boolean
}

interface SandboxDetailsProps {
  sandboxId: string | null
  sandboxName: string | null
  sandboxIP: string | null
  sandboxStatus: string | null
}

export default function SandboxDetails({
  sandboxId,
  sandboxName,
  sandboxIP,
  sandboxStatus
}: SandboxDetailsProps) {
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    cpu: 0, memory: 0, disk: 0
  })
  const [loading, setLoading] = useState(false)
  const [config, setConfig] = useState<SandboxConfig[]>([
    { name: 'autoRestart', description: 'Automatically restart on failure', enabled: true },
    { name: 'networkAccess', description: 'Allow network access', enabled: true },
    { name: 'gpuEnabled', description: 'Enable GPU acceleration', enabled: true },
    { name: 'persistentStorage', description: 'Use persistent storage', enabled: false },
    { name: 'debugMode', description: 'Enable debug logging', enabled: false }
  ])

  const fetchTelemetry = useCallback(async () => {
    if (!sandboxId) return
    setLoading(true)
    try {
      const response = await fetch('/api/telemetry/combined')
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
    } finally {
      setLoading(false)
    }
  }, [sandboxId])

  useEffect(() => {
    if (sandboxId) {
      fetchTelemetry()
      const interval = setInterval(fetchTelemetry, 5000)
      return () => clearInterval(interval)
    }
  }, [sandboxId, fetchTelemetry])

  const toggleConfig = (name: string) => {
    setConfig(config.map(item =>
      item.name === name ? { ...item, enabled: !item.enabled } : item
    ))
  }

  if (!sandboxId) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 text-[var(--foreground-dim)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeLinejoin="miter" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
          <h3 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">Select a Sandbox</h3>
          <p className="text-xs text-[var(--foreground-dim)] mt-2">
            Choose a sandbox from the menu to view details
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header - Technical Panel */}
      <div className="panel p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-mono font-semibold text-[var(--foreground)] uppercase tracking-tight">
              {sandboxName}
            </h2>
            <div className="flex items-center gap-4 mt-3">
              <span className="text-xs text-[var(--foreground-dim)] font-mono">
                IP: {sandboxIP}
              </span>
              <span className={`px-2 py-0.5 rounded-sm text-[10px] font-mono uppercase ${
                sandboxStatus === 'running'
                  ? 'bg-[var(--status-running)] text-white'
                  : 'bg-[var(--status-pending)] text-white'
              }`}>
                {sandboxStatus?.toUpperCase() || 'UNKNOWN'}
              </span>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">Running</p>
            <p className="text-xs font-mono text-[var(--nvidia-green)]">OPENSHELL</p>
          </div>
        </div>
      </div>

      {/* Telemetry Grid - Technical */}
      <div className="panel p-6">
        <h3 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wider mb-4">
          TELEMETRY
        </h3>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <CompactGauge
            value={telemetry.cpu}
            max={100}
            unit="%"
            color="#76B900"
            label="CPU"
          />
          <CompactGauge
            value={telemetry.memory}
            max={100}
            unit="%"
            color="#76B900"
            label="MEMORY"
          />
          <CompactGauge
            value={telemetry.disk}
            max={100}
            unit="%"
            color="#76B900"
            label="DISK"
          />
          {telemetry.gpuMemoryUsed !== undefined && telemetry.gpuMemoryTotal && (
            <CompactGauge
              value={(telemetry.gpuMemoryUsed / telemetry.gpuMemoryTotal) * 100}
              max={100}
              unit="%"
              color="#0D47A1"
              label="GPU MEM"
            />
          )}
        </div>
        {telemetry.gpuTemperature && (
          <div className="mt-4 metric p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[var(--foreground-dim)] uppercase tracking-wider">GPU Temperature</span>
              <span className="text-xl font-mono text-[var(--nvidia-green)]">
                {telemetry.gpuTemperature.toFixed(1)}°C
              </span>
            </div>
          </div>
        )}
        <p className="text-[10px] text-[var(--foreground-dim)] mt-4 text-right font-mono uppercase tracking-wider">
          Updated: {new Date(telemetry.timestamp || Date.now()).toLocaleTimeString()}
        </p>
      </div>

      {/* Configuration - Technical */}
      <div className="panel p-6">
        <h3 className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wider mb-4">
          SANDBOX CONFIGURATION
        </h3>
        <div className="space-y-2">
          {config.map((item) => (
            <label
              key={item.name}
              className="flex items-center justify-between p-3 rounded-sm hover:bg-[var(--background-tertiary)] transition-colors cursor-pointer border border-transparent hover:border-[var(--border-subtle)]"
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={item.enabled}
                  onChange={() => toggleConfig(item.name)}
                  className="w-4 h-4 rounded-sm border-[var(--border-medium)] bg-[var(--metric-bg)] text-[var(--nvidia-green)] focus:ring-[var(--nvidia-green)] focus:ring-offset-0"
                />
                <span className="text-sm font-mono text-[var(--foreground)]">
                  {item.name.replace(/([A-Z])/g, ' $1').trim().toUpperCase()}
                </span>
              </div>
              <span className="text-[10px] text-[var(--foreground-dim)] text-right max-w-[180px]">
                {item.description}
              </span>
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}
