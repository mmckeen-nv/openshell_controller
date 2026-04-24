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

interface Sandbox {
  id: string
  name: string
  ip: string
  status: string
}

export default function CompactTelemetryDisplay() {
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    cpu: 0, memory: 0, disk: 0
  })
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSandbox, setSelectedSandbox] = useState<string | null>(null)

  useEffect(() => {
    fetchSandboxes()
  }, [])

  const fetchSandboxes = async () => {
    try {
      const response = await fetch('/api/telemetry/real')
      const data = await response.json()
      const sandboxList = (data.pods?.items || []).slice(0, 5).map((pod: any, index: number) => ({
        id: pod.metadata?.name || `sandbox-${index}`,
        name: pod.metadata?.name?.substring(0, 15) || `Sandbox ${index + 1}`,
        ip: pod.status?.podIP || `10.42.0.${index + 1}`,
        status: pod.status?.phase || 'Unknown'
      }))
      setSandboxes(sandboxList)
    } catch (error) {
      console.error('Error fetching sandboxes:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchTelemetry = useCallback(async () => {
    try {
      const response = await fetch('/api/telemetry/combined')
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
    }
  }, [])

  const fetchCombinedTelemetry = fetchTelemetry

  useEffect(() => {
    if (selectedSandbox) {
      fetchTelemetry()
    } else {
      fetchCombinedTelemetry()
    }
  }, [selectedSandbox, fetchTelemetry, fetchCombinedTelemetry])

  useEffect(() => {
    const interval = setInterval(() => {
      if (selectedSandbox) {
        fetchTelemetry()
      } else {
        fetchCombinedTelemetry()
      }
    }, 5000)
    return () => clearInterval(interval)
  }, [selectedSandbox, fetchTelemetry, fetchCombinedTelemetry])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <span className="text-[10px] text-[var(--foreground-dim)] font-mono uppercase tracking-wider">
          INITIALIZING TELEMETRY...
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Sandbox Selector - Technical */}
      {sandboxes.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            onClick={() => setSelectedSandbox(null)}
            className={`px-3 py-1 rounded-sm text-xs font-mono uppercase tracking-wider transition-colors ${
              !selectedSandbox
                ? 'bg-[var(--nvidia-green)] text-white'
                : 'bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:bg-[var(--background-panel)]'
            }`}
          >
            ALL ({sandboxes.length})
          </button>
          {sandboxes.map((sandbox) => (
            <button
              key={sandbox.id}
              onClick={() => setSelectedSandbox(sandbox.id)}
              className={`px-3 py-1 rounded-sm text-xs font-mono uppercase tracking-wider transition-colors ${
                selectedSandbox === sandbox.id
                  ? 'bg-[var(--nvidia-green)] text-white'
                  : 'bg-[var(--background-tertiary)] text-[var(--foreground-dim)] hover:bg-[var(--background-panel)]'
              }`}
            >
              {sandbox.name}
            </button>
          ))}
        </div>
      )}

      {/* Main Metrics - 2x2 Grid */}
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

      {/* Secondary Metrics - Technical Panels */}
      {(telemetry.gpuTemperature || telemetry.gpuMemoryUsed) && (
        <div className="grid grid-cols-2 gap-4">
          {telemetry.gpuTemperature && (
            <div className="metric p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">GPU TEMP</span>
                <span className="text-xl font-mono text-[var(--nvidia-green)]">
                  {telemetry.gpuTemperature.toFixed(1)}°C
                </span>
              </div>
            </div>
          )}
          {telemetry.gpuMemoryUsed !== undefined && telemetry.gpuMemoryTotal && (
            <div className="metric p-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[var(--foreground-dim)] uppercase tracking-wider">GPU USED</span>
                <span className="text-xl font-mono text-[var(--nvidia-green)]">
                  {telemetry.gpuMemoryUsed.toFixed(1)} / {telemetry.gpuMemoryTotal.toFixed(1)} GB
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Status Bar - Technical */}
      <div className="flex items-center justify-between text-[10px] text-[var(--foreground-dim)] mt-4 pt-4 border-t border-[var(--border-subtle)]">
        <span className="font-mono uppercase tracking-wider">
          LAST UPDATE: {new Date(telemetry.timestamp || Date.now()).toLocaleTimeString()}
        </span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 bg-[var(--status-running)] animate-pulse"></span>
          <span className="font-mono uppercase">LIVE</span>
        </span>
      </div>
    </div>
  )
}
