"use client"

import { useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

type LiveTelemetrySnapshot = {
  ok?: boolean
  timestamp?: string
  windowMs?: number
  transactionsPerSecond?: number
  mcpRequestsPerSecond?: number
  mcpCallsPerSecond?: number
  tokensPerSecond?: number
  promptTokensPerSecond?: number
  generationTokensPerSecond?: number
  tokenSource?: "vllm" | "observed" | "not_configured" | "unavailable" | string
  tokenEndpoint?: string
  tokenError?: string | null
  concurrentTasks?: number
  totals?: {
    transactions?: number
    mcpRequests?: number
    mcpCalls?: number
    mcpLists?: number
    mcpErrors?: number
    tokens?: number
    promptTokens?: number
    generationTokens?: number
  }
}

const EMPTY_SNAPSHOT: LiveTelemetrySnapshot = {
  transactionsPerSecond: 0,
  mcpRequestsPerSecond: 0,
  mcpCallsPerSecond: 0,
  tokensPerSecond: 0,
  promptTokensPerSecond: 0,
  generationTokensPerSecond: 0,
  tokenSource: "not_configured",
  concurrentTasks: 0,
  totals: {},
}

function formatRate(value: number | undefined) {
  const safeValue = Number.isFinite(value) ? Number(value) : 0
  if (safeValue >= 100) return safeValue.toFixed(0)
  if (safeValue >= 10) return safeValue.toFixed(1)
  return safeValue.toFixed(2)
}

function Gauge({ value, max }: { value: number; max: number }) {
  const clamped = Math.max(0, Math.min(value / Math.max(max, 1), 1))
  const angle = -120 + clamped * 240
  const dash = 126 * clamped

  return (
    <div className="relative h-16 w-20 shrink-0">
      <svg viewBox="0 0 80 56" className="h-full w-full" aria-hidden="true">
        <path d="M12 46a28 28 0 0 1 56 0" fill="none" stroke="var(--border-subtle)" strokeWidth="8" strokeLinecap="square" pathLength="126" />
        <path d="M12 46a28 28 0 0 1 56 0" fill="none" stroke="var(--nvidia-green)" strokeWidth="8" strokeLinecap="square" pathLength="126" strokeDasharray={`${dash} 126`} />
        <line x1="40" y1="46" x2="40" y2="22" stroke="var(--foreground)" strokeWidth="2" strokeLinecap="square" transform={`rotate(${angle} 40 46)`} />
        <circle cx="40" cy="46" r="3" fill="var(--foreground)" />
      </svg>
    </div>
  )
}

function MetricBlock({
  label,
  value,
  subtext,
  children,
}: {
  label: string
  value: string
  subtext: string
  children?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 border-l border-[var(--border-subtle)] px-5 first:border-l-0 max-md:border-l-0 max-md:border-t max-md:py-4">
      {children}
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{label}</p>
        <p className="mt-1 font-mono text-2xl text-[var(--foreground)]">{value}</p>
        <p className="mt-1 truncate text-[11px] text-[var(--foreground-dim)]">{subtext}</p>
      </div>
    </div>
  )
}

export default function LiveTelemetryBar() {
  const [snapshot, setSnapshot] = useState<LiveTelemetrySnapshot>(EMPTY_SNAPSHOT)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const response = await fetch("/api/telemetry/live", { cache: "no-store" })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || "Failed to load live telemetry")
        if (active) {
          setSnapshot(data)
          setError("")
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Telemetry unavailable")
      }
    }

    load()
    const interval = window.setInterval(load, 1000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [])

  const maxTps = useMemo(() => Math.max(5, Math.ceil((snapshot.transactionsPerSecond || 0) * 1.6)), [snapshot.transactionsPerSecond])
  const generatedRate = snapshot.generationTokensPerSecond ?? snapshot.tokensPerSecond
  const promptRate = snapshot.promptTokensPerSecond || 0
  const tokenText = snapshot.tokenSource === "vllm" || snapshot.tokenSource === "observed"
    ? `${formatRate(generatedRate)}/s`
    : "waiting"
  const tokenSubtext = snapshot.tokenSource === "vllm"
    ? `generated avg; prompt ${formatRate(promptRate)}/s`
    : snapshot.tokenError || "token source not wired yet"

  return (
    <section className="panel mb-6 overflow-hidden" aria-label="Live activity telemetry">
      <div className="grid grid-cols-1 md:grid-cols-[1.1fr_1fr_1fr]">
        <MetricBlock
          label="Transactions Per Second"
          value={`${formatRate(snapshot.transactionsPerSecond)}/s`}
          subtext={`MCP requests ${formatRate(snapshot.mcpRequestsPerSecond)}/s over ${Math.round((snapshot.windowMs || 10000) / 1000)}s`}
        >
          <Gauge value={snapshot.transactionsPerSecond || 0} max={maxTps} />
        </MetricBlock>
        <MetricBlock
          label="Generated Tokens Per Second"
          value={tokenText}
          subtext={tokenSubtext}
        />
        <MetricBlock
          label="Concurrent Tasks"
          value={String(snapshot.concurrentTasks || 0)}
          subtext={`${snapshot.totals?.mcpRequests || 0} MCP requests, ${snapshot.totals?.mcpCalls || 0} tool calls`}
        />
      </div>
      {error && (
        <div className="border-t border-[var(--border-subtle)] px-5 py-2 text-[11px] text-[var(--status-stopped)]">
          {error}
        </div>
      )}
    </section>
  )
}
