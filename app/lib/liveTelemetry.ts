type TelemetryEventKind = "transaction" | "mcp_request" | "mcp_call" | "mcp_list" | "mcp_error" | "token"

type TelemetryEvent = {
  kind: TelemetryEventKind
  at: number
  count: number
  sandboxId?: string | null
  serverId?: string | null
  toolName?: string | null
}

type ActiveTask = {
  id: number
  kind: TelemetryEventKind
  startedAt: number
  sandboxId?: string | null
  serverId?: string | null
  toolName?: string | null
}

type LiveTelemetryState = {
  activeTasks: Map<number, ActiveTask>
  events: TelemetryEvent[]
  nextTaskId: number
  tokenMetrics: {
    source: string
    endpoint: string
    lastPromptTotal: number | null
    lastGenerationTotal: number | null
    lastAt: number | null
    promptRate: number
    generationRate: number
    promptTotal: number
    generationTotal: number
    samples: Array<{
      at: number
      promptDelta: number
      generationDelta: number
      elapsedSeconds: number
    }>
    error: string | null
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __openshellControlLiveTelemetry: LiveTelemetryState | undefined
}

const WINDOW_MS = 60000

function state() {
  globalThis.__openshellControlLiveTelemetry ??= {
    activeTasks: new Map<number, ActiveTask>(),
    events: [],
    nextTaskId: 1,
    tokenMetrics: {
      source: "not_configured",
      endpoint: "",
      lastPromptTotal: null,
      lastGenerationTotal: null,
      lastAt: null,
      promptRate: 0,
      generationRate: 0,
      promptTotal: 0,
      generationTotal: 0,
      samples: [],
      error: null,
    },
  }
  return globalThis.__openshellControlLiveTelemetry
}

function now() {
  return Date.now()
}

function prune(cutoff = now() - WINDOW_MS) {
  const { events } = state()
  while (events.length > 0 && events[0].at < cutoff) events.shift()
}

export function recordLiveTelemetryEvent(
  kind: TelemetryEventKind,
  options?: Omit<TelemetryEvent, "kind" | "at" | "count"> & { count?: number },
) {
  const { events } = state()
  events.push({
    kind,
    at: now(),
    count: Math.max(0, options?.count ?? 1),
    sandboxId: options?.sandboxId ?? null,
    serverId: options?.serverId ?? null,
    toolName: options?.toolName ?? null,
  })
  prune()
}

export function startLiveTelemetryTask(
  kind: TelemetryEventKind,
  options?: Omit<ActiveTask, "id" | "kind" | "startedAt">,
) {
  const telemetryState = state()
  const id = telemetryState.nextTaskId
  telemetryState.nextTaskId += 1
  telemetryState.activeTasks.set(id, {
    id,
    kind,
    startedAt: now(),
    sandboxId: options?.sandboxId ?? null,
    serverId: options?.serverId ?? null,
    toolName: options?.toolName ?? null,
  })
  return () => {
    state().activeTasks.delete(id)
  }
}

function rateFor(kind: TelemetryEventKind, windowMs: number) {
  const cutoff = now() - windowMs
  return state().events
    .filter((event) => event.kind === kind && event.at >= cutoff)
    .reduce((total, event) => total + event.count, 0) / (windowMs / 1000)
}

function countFor(kind: TelemetryEventKind, windowMs: number) {
  const cutoff = now() - windowMs
  return state().events
    .filter((event) => event.kind === kind && event.at >= cutoff)
    .reduce((total, event) => total + event.count, 0)
}

function tokenMetricsUrl() {
  const explicit = process.env.LIVE_TELEMETRY_TOKEN_METRICS_URL
    || process.env.VLLM_METRICS_URL
    || process.env.NEMOCLAW_VLLM_METRICS_URL
  if (explicit?.trim()) return explicit.trim()

  const base = process.env.VLLM_BASE_URL
    || process.env.OPENAI_BASE_URL
    || process.env.MCP_PREFLIGHT_LLM_BASE_URL
  if (base?.trim()) {
    try {
      const url = new URL(base)
      url.pathname = "/metrics"
      url.search = ""
      url.hash = ""
      return url.toString()
    } catch {
      return ""
    }
  }

  return "http://localhost:8000/metrics"
}

function sumPrometheusMetrics(text: string, names: string[]) {
  const wanted = new Set(names)
  let total = 0
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{[^}]*\})?\s+(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i)
    if (!match || !wanted.has(match[1])) continue
    const value = Number(match[2])
    if (Number.isFinite(value)) total += value
  }
  return total
}

function sumSamples(samples: LiveTelemetryState["tokenMetrics"]["samples"], field: "promptDelta" | "generationDelta") {
  return samples.reduce((total, sample) => total + sample[field], 0)
}

function sampleSeconds(samples: LiveTelemetryState["tokenMetrics"]["samples"]) {
  return samples.reduce((total, sample) => total + sample.elapsedSeconds, 0)
}

async function refreshTokenMetrics() {
  const telemetryState = state()
  const endpoint = tokenMetricsUrl()
  if (!endpoint) {
    telemetryState.tokenMetrics = {
      ...telemetryState.tokenMetrics,
      source: "not_configured",
      endpoint: "",
      promptRate: 0,
      generationRate: 0,
      error: "No token metrics endpoint configured",
    }
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 1500)
  try {
    const response = await fetch(endpoint, {
      cache: "no-store",
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`metrics returned HTTP ${response.status}`)
    const metrics = await response.text()
    const promptTotal = sumPrometheusMetrics(metrics, ["vllm:prompt_tokens_total"])
    const generationTotal = sumPrometheusMetrics(metrics, ["vllm:generation_tokens_total"])
    const at = now()
    const previousPromptTotal = telemetryState.tokenMetrics.lastPromptTotal
    const previousGenerationTotal = telemetryState.tokenMetrics.lastGenerationTotal
    const previousAt = telemetryState.tokenMetrics.lastAt
    const elapsedSeconds = previousAt ? (at - previousAt) / 1000 : 0
    const promptDelta = previousPromptTotal === null ? 0 : Math.max(0, promptTotal - previousPromptTotal)
    const generationDelta = previousGenerationTotal === null ? 0 : Math.max(0, generationTotal - previousGenerationTotal)
    const previousSamples = telemetryState.tokenMetrics.samples || []
    const samples = elapsedSeconds > 0
      ? [...previousSamples, { at, promptDelta, generationDelta, elapsedSeconds }]
      : previousSamples
    const cutoff = at - WINDOW_MS
    const recentSamples = samples.filter((sample) => sample.at >= cutoff)
    const recentSeconds = sampleSeconds(recentSamples)

    telemetryState.tokenMetrics = {
      source: "vllm",
      endpoint,
      lastPromptTotal: promptTotal,
      lastGenerationTotal: generationTotal,
      lastAt: at,
      promptRate: recentSeconds > 0 ? sumSamples(recentSamples, "promptDelta") / recentSeconds : 0,
      generationRate: recentSeconds > 0 ? sumSamples(recentSamples, "generationDelta") / recentSeconds : 0,
      promptTotal,
      generationTotal,
      samples: recentSamples,
      error: null,
    }
  } catch (error) {
    telemetryState.tokenMetrics = {
      ...telemetryState.tokenMetrics,
      source: telemetryState.tokenMetrics.lastGenerationTotal === null ? "unavailable" : telemetryState.tokenMetrics.source,
      endpoint,
      promptRate: 0,
      generationRate: 0,
      error: error instanceof Error ? error.message : "Token metrics unavailable",
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function readLiveTelemetrySnapshot() {
  await refreshTokenMetrics()
  const snapshotAt = now()
  prune(snapshotAt - WINDOW_MS)
  const windowMs = WINDOW_MS
  const active = Array.from(state().activeTasks.values())
  const tokenMetrics = state().tokenMetrics

  return {
    ok: true,
    timestamp: new Date(snapshotAt).toISOString(),
    windowMs,
    transactionsPerSecond: rateFor("transaction", windowMs),
    mcpRequestsPerSecond: rateFor("mcp_request", windowMs),
    mcpCallsPerSecond: rateFor("mcp_call", windowMs),
    tokensPerSecond: tokenMetrics.generationRate,
    promptTokensPerSecond: tokenMetrics.promptRate,
    generationTokensPerSecond: tokenMetrics.generationRate,
    tokenSource: tokenMetrics.source,
    tokenEndpoint: tokenMetrics.endpoint,
    tokenError: tokenMetrics.error,
    concurrentTasks: active.length,
    activeTasks: active.map((task) => ({
      kind: task.kind,
      ageMs: snapshotAt - task.startedAt,
      sandboxId: task.sandboxId,
      serverId: task.serverId,
      toolName: task.toolName,
    })),
    totals: {
      transactions: countFor("transaction", windowMs),
      mcpRequests: countFor("mcp_request", windowMs),
      mcpCalls: countFor("mcp_call", windowMs),
      mcpLists: countFor("mcp_list", windowMs),
      mcpErrors: countFor("mcp_error", windowMs),
      tokens: tokenMetrics.promptTotal + tokenMetrics.generationTotal,
      promptTokens: tokenMetrics.promptTotal,
      generationTokens: tokenMetrics.generationTotal,
    },
  }
}
