"use client"

import { useEffect, useState } from "react"

type ActivityEntry = {
  id: string
  timestamp: string
  type: string
  message: string
  sandboxName?: string
  status?: "success" | "error" | "info" | "warning"
}

function toneClass(status?: ActivityEntry["status"]) {
  if (status === "success") return "bg-[var(--status-running-bg)] text-[var(--status-running)]"
  if (status === "error") return "bg-red-500/15 text-red-300"
  if (status === "warning") return "bg-amber-400/15 text-amber-300"
  return "bg-[var(--background-tertiary)] text-[var(--foreground-dim)]"
}

export default function ActivityPanel() {
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [loading, setLoading] = useState(false)

  async function loadActivity() {
    try {
      setLoading(true)
      const response = await fetch("/api/activity?limit=40", { cache: "no-store" })
      const data = await response.json()
      if (Array.isArray(data?.entries)) setEntries(data.entries)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadActivity()
  }, [])

  return (
    <section className="panel p-5">
      <div className="flex items-start justify-between gap-4 max-md:flex-col">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Activity Log</h2>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">Recent backup, restore, catalog, and support actions recorded by the controller.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={loadActivity} disabled={loading} className="action-button px-3 py-2">
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <a href="/api/support-bundle" className="action-button px-3 py-2">
            Support Bundle
          </a>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-xs font-mono text-[var(--foreground)]">{entry.message}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">
                  {entry.sandboxName || entry.type} / {new Date(entry.timestamp).toLocaleString()}
                </p>
              </div>
              <span className={`status-chip shrink-0 px-2 py-1 ${toneClass(entry.status)}`}>
                {entry.status || "info"}
              </span>
            </div>
          </div>
        ))}
        {entries.length === 0 && (
          <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4 text-sm text-[var(--foreground-dim)]">
            No activity recorded yet.
          </div>
        )}
      </div>
    </section>
  )
}
