"use client"
import { useState, useEffect, useCallback } from 'react'
import SpeedometerGauge from './SpeedometerGauge'

interface TelemetryData {
  cpu: number
  memory: number
  disk: number
  gpuMemoryUsed?: number
  gpuMemoryTotal?: number
  gpuTemperature?: number
}

interface Sandbox {
  id: string
  name: string
  ip: string
  status: string
}

export default function TelemetryDisplay() {
  const [selectedSandbox, setSelectedSandbox] = useState<string | null>(null)
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    cpu: 0,
    memory: 0,
    disk: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0
  })
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([])
  const [loading, setLoading] = useState(true)

  // Fetch sandboxes
  useEffect(() => {
    fetchSandboxes()
  }, [])

  const fetchSandboxes = async () => {
    try {
      const response = await fetch('/api/telemetry/real')
      const data = await response.json()
      // Filter sandboxes from pod data
      const sandboxList = (data.pods?.items || []).map((pod: any, index: number) => ({
        id: pod.metadata?.name || `sandbox-${index}`,
        name: pod.metadata?.name || `Sandbox ${index + 1}`,
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

  const fetchTelemetry = useCallback(async (sandboxId: string) => {
    try {
      const response = await fetch(`/api/telemetry/sandbox/${sandboxId}`)
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
    }
  }, [])

  const fetchCombinedTelemetry = useCallback(async () => {
    try {
      const response = await fetch('/api/telemetry/combined')
      const data = await response.json()
      setTelemetry(data)
    } catch (error) {
      console.error('Error fetching telemetry:', error)
    }
  }, [])

  const handleSandboxClick = (sandboxId: string | null) => {
    setSelectedSandbox(current => current === sandboxId ? null : sandboxId)
  }

  // Fetch telemetry when sandbox changes
  useEffect(() => {
    if (selectedSandbox) {
      fetchTelemetry(selectedSandbox)
    } else {
      fetchCombinedTelemetry()
    }
  }, [selectedSandbox, fetchTelemetry, fetchCombinedTelemetry])

  if (loading) {
    return <div className="text-center text-gray-600 dark:text-gray-400">Loading telemetry...</div>
  }

  return (
    <div className="space-y-6">
      {/* Sandbox Selection */}
      {sandboxes.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-lg font-semibold mb-3 dark:text-white">Select Sandbox</h3>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleSandboxClick(null)}
              className={`px-4 py-2 rounded-lg ${
                !selectedSandbox
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
              }`}
            >
              Combined ({sandboxes.length} sandboxes)
            </button>
            {sandboxes.map((sandbox) => (
              <button
                key={sandbox.id}
                onClick={() => handleSandboxClick(sandbox.id)}
                className={`px-4 py-2 rounded-lg ${
                  selectedSandbox === sandbox.id
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200'
                }`}
              >
                {sandbox.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Telemetry Gauges */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <SpeedometerGauge
          value={telemetry.cpu}
          max={100}
          unit="%"
          color="#76B900"
          label="CPU Usage"
          size="large"
        />
        <SpeedometerGauge
          value={telemetry.memory}
          max={100}
          unit="%"
          color="#76B900"
          label="Memory Usage"
          size="large"
        />
        <SpeedometerGauge
          value={telemetry.disk}
          max={100}
          unit="%"
          color="#76B900"
          label="Disk Usage"
          size="large"
        />
        {telemetry.gpuMemoryUsed !== undefined && telemetry.gpuMemoryTotal && (
          <SpeedometerGauge
            value={(telemetry.gpuMemoryUsed / telemetry.gpuMemoryTotal) * 100}
            max={100}
            unit="%"
            color="#0D47A1"
            label="GPU Memory"
            size="large"
          />
        )}
      </div>

      {/* Additional Metrics */}
      {telemetry.gpuTemperature !== undefined && telemetry.gpuMemoryUsed !== undefined && telemetry.gpuMemoryTotal !== undefined && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4 dark:text-white">GPU Metrics</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Temperature</p>
              <p className="text-2xl font-bold text-blue-600">
                {telemetry.gpuTemperature.toFixed(1)}°C
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600 dark:text-gray-400">Memory Used</p>
              <p className="text-2xl font-bold text-blue-600">
                {telemetry.gpuMemoryUsed.toFixed(1)} / {telemetry.gpuMemoryTotal.toFixed(1)} GB
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Selected Sandbox Info */}
      {selectedSandbox && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4">
          <h3 className="text-lg font-semibold mb-2 dark:text-white">Selected Sandbox</h3>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            IP: {sandboxes.find(s => s.id === selectedSandbox)?.ip}
          </p>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Status: {sandboxes.find(s => s.id === selectedSandbox)?.status}
          </p>
        </div>
      )}
    </div>
  )
}