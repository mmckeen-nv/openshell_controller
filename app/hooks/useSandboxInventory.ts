"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export interface SandboxInventoryItem {
  id: string
  name: string
  namespace: string
  ip: string
  status: 'running' | 'pending' | 'stopped' | 'unknown' | 'error'
  ready: boolean
  sshHostAlias?: string
  isDefault?: boolean
}

export interface NemoClawSummary {
  available: boolean
  defaultSandboxNames: string[]
  serviceLines: string[]
  summaryLines: string[]
  source: 'nemoclaw-cli' | 'none'
}

interface InventoryResponse {
  sandboxes?: any[]
  pods?: { items?: any[] }
  nemoclaw?: NemoClawSummary | null
}

function normalizeStatus(status: unknown): SandboxInventoryItem['status'] {
  const value = typeof status === 'string' ? status.toLowerCase() : 'unknown'
  if (value === 'running' || value === 'pending' || value === 'stopped' || value === 'error') return value
  return 'unknown'
}

function mapSandboxSummary(sandbox: any): SandboxInventoryItem {
  const status = normalizeStatus(sandbox.status)
  return {
    id: sandbox.id || sandbox.name || 'unknown',
    name: sandbox.name || 'Unknown Sandbox',
    namespace: sandbox.namespace || 'openshell',
    ip: sandbox.sshHostAlias || 'N/A',
    status,
    ready: status === 'running',
    sshHostAlias: sandbox.sshHostAlias || undefined,
    isDefault: Boolean(sandbox.isDefault),
  }
}

function mapPodItem(pod: any): SandboxInventoryItem {
  const status = normalizeStatus(pod.status?.phase)
  return {
    id: pod.metadata?.labels?.['nemoclaw.ai/sandbox-id'] || pod.metadata?.name || 'unknown',
    name: pod.metadata?.labels?.['nemoclaw.ai/sandbox-name'] || pod.metadata?.name || 'Unknown Sandbox',
    namespace: pod.metadata?.namespace || 'unknown',
    ip: pod.status?.podIP || 'N/A',
    status,
    ready: pod.status?.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True',
    sshHostAlias: pod.status?.podIP || undefined,
    isDefault: pod.metadata?.labels?.['nemoclaw.ai/default'] === 'true',
  }
}

function normalizeFromResponse(data: InventoryResponse): SandboxInventoryItem[] {
  if (Array.isArray(data?.sandboxes)) {
    return data.sandboxes.map(mapSandboxSummary)
  }

  return (data?.pods?.items || [])
    .filter((pod: any) => Boolean(pod?.metadata?.name))
    .map(mapPodItem)
}

export function useSandboxInventory(options?: { enabled?: boolean; refreshIntervalMs?: number }) {
  const enabled = options?.enabled ?? true
  const refreshIntervalMs = options?.refreshIntervalMs ?? 10000
  const [sandboxes, setSandboxes] = useState<SandboxInventoryItem[]>([])
  const [nemoclaw, setNemoclaw] = useState<NemoClawSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlightRef = useRef<Promise<SandboxInventoryItem[]> | null>(null)

  const refresh = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current
    }

    const run = (async () => {
      try {
        const response = await fetch('/api/telemetry/real', { cache: 'no-store' })
        const data: InventoryResponse & { error?: string } = await response.json()
        if (!response.ok) throw new Error(data.error || 'Failed to fetch sandbox inventory')

        const nextSandboxes = normalizeFromResponse(data)
        setSandboxes(nextSandboxes)
        setNemoclaw(data?.nemoclaw ?? null)
        setError(null)
        return nextSandboxes
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to fetch sandbox inventory'
        setSandboxes([])
        setNemoclaw(null)
        setError(message)
        throw err
      } finally {
        setLoading(false)
        inFlightRef.current = null
      }
    })()

    inFlightRef.current = run
    return run
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }

    let active = true
    setLoading(true)
    refresh().catch(() => {
      if (!active) return
    })

    const interval = window.setInterval(() => {
      refresh().catch(() => {})
    }, refreshIntervalMs)

    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [enabled, refresh, refreshIntervalMs])

  const byId = useMemo(() => {
    const map = new Map<string, SandboxInventoryItem>()
    for (const sandbox of sandboxes) map.set(sandbox.id, sandbox)
    return map
  }, [sandboxes])

  return {
    sandboxes,
    nemoclaw,
    loading,
    error,
    refresh,
    byId,
  }
}
