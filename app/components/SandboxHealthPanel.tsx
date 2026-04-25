"use client"

import { useCallback, useEffect, useState } from "react"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

type HealthCheck = {
  key: string
  label: string
  ok: boolean
  detail: string
}

type HealthResponse = {
  ok: boolean
  error?: string
  sandbox?: {
    id: string | null
    name: string
    phase: string
  }
  checks: HealthCheck[]
  backupCount?: number
  durationMs: number
  checkedAt: string
}

export default function SandboxHealthPanel({ sandbox }: { sandbox: SandboxInventoryItem }) {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [loading, setLoading] = useState(false)

  const loadHealth = useCallback(async () => {
    try {
      setLoading(true)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/health`, { cache: "no-store" })
      const data = await response.json()
      setHealth(data)
    } catch (error) {
      setHealth({
        ok: false,
        error: error instanceof Error ? error.message : "Health check failed",
        checks: [],
        durationMs: 0,
        checkedAt: new Date().toISOString(),
      })
    } finally {
      setLoading(false)
    }
  }, [sandbox.id])

  useEffect(() => {
    loadHealth()
  }, [loadHealth])

  const checks = health?.checks || []

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 max-lg:flex-col">
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Sandbox Health</h5>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">
            Quick checks for OpenShell resolution, runtime phase, SSH config, and saved backups.
          </p>
        </div>
        <button
          type="button"
          onClick={loadHealth}
          disabled={loading}
          className="action-button px-3 py-2"
        >
          {loading ? "Checking..." : "Refresh Health"}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(checks.length ? checks : [{ key: "loading", label: "Health", ok: false, detail: loading ? "Checking..." : "No health data yet." }]).map((check) => (
          <div key={check.key} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4">
            <div className="flex items-center justify-between gap-3">
              <h6 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--foreground)]">{check.label}</h6>
              <span className={`status-chip px-2 py-1 ${check.ok ? "bg-[var(--status-running-bg)] text-[var(--status-running)]" : "bg-amber-400/15 text-amber-300"}`}>
                {check.ok ? "ok" : "check"}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-[var(--foreground-dim)]">{check.detail}</p>
          </div>
        ))}
      </div>

      {health && (
        <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-xs text-[var(--foreground-dim)]">
          Checked {new Date(health.checkedAt).toLocaleString()} in {health.durationMs} ms
          {health.sandbox ? ` / ${health.sandbox.name} / ${health.sandbox.phase}` : ""}
          {health.error ? ` / ${health.error}` : ""}
        </div>
      )}
    </div>
  )
}
