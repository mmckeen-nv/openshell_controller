"use client"

import { Suspense, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"

function LaunchDashboardInner() {
  const params = useSearchParams()
  const sandboxId = params.get("sandboxId") || ""
  const instanceId = params.get("instanceId") || ""
  const [message, setMessage] = useState("Connecting to the OpenClaw gateway…")

  useEffect(() => {
    let cancelled = false
    const open = async () => {
      try {
        if (!sandboxId && !instanceId) {
          setMessage("Missing sandboxId. Add ?sandboxId=<name> to the URL.")
          return
        }
        const query = new URLSearchParams()
        if (sandboxId) query.set("sandboxId", sandboxId)
        if (instanceId) query.set("instanceId", instanceId)
        const response = await fetch(`/api/openshell/dashboard/open?${query.toString()}`, { cache: "no-store" })
        const data = await response.json()
        if (cancelled) return
        if (!response.ok || !data.ok) {
          setMessage(data.error || "Failed to resolve the OpenClaw dashboard URL.")
          return
        }
        const target = data.launchUrl || data.proxiedUrl || data.dashboardUrl
        if (!target) {
          setMessage("The dashboard endpoint did not return a launch URL.")
          return
        }
        window.location.replace(target)
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Failed to open the dashboard.")
      }
    }
    open()
    return () => { cancelled = true }
  }, [sandboxId, instanceId])

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] flex items-center justify-center p-6">
      <section className="panel max-w-md w-full p-8 space-y-4 text-center">
        <h1 className="text-sm uppercase tracking-[0.2em] text-[var(--foreground-dim)]">OpenClaw Gateway Dashboard</h1>
        <p className="text-base text-[var(--foreground)]">{sandboxId || instanceId || "(no sandbox)"}</p>
        <p className="text-xs text-[var(--foreground-dim)]">{message}</p>
      </section>
    </main>
  )
}

export default function LaunchDashboardPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] p-8">Loading…</main>}>
      <LaunchDashboardInner />
    </Suspense>
  )
}
