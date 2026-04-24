"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

type ProviderSummary = {
  id: string | null
  name: string | null
  type: string | null
}

type OllamaModel = {
  name: string
  sizeLabel: string | null
  parameterSize: string | null
  quantization: string | null
}

type SandboxInferenceRoute = {
  id: string
  provider: string
  model: string
  enabled: boolean
  label: string
}

type SandboxInferenceConfig = {
  sandboxId: string
  provider: string
  primaryModel: string
  models: string[]
  routes: SandboxInferenceRoute[]
  primaryRouteId: string
  updatedAt: string | null
}

function makeRoute(provider: string, model: string, label = ""): SandboxInferenceRoute {
  return {
    id: `${provider}::${model}`,
    provider,
    model,
    enabled: true,
    label,
  }
}

function routeKey(route: Pick<SandboxInferenceRoute, "provider" | "model">) {
  return `${route.provider}::${route.model}`
}

function dedupeRoutes(routes: SandboxInferenceRoute[]) {
  return Array.from(new Map(routes
    .filter((route) => route.provider.trim() && route.model.trim())
    .map((route) => [route.id || routeKey(route), { ...route, id: route.id || routeKey(route) }])).values())
}

export default function SandboxInferencePanel({ sandbox }: { sandbox: SandboxInventoryItem }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState("")
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [routes, setRoutes] = useState<SandboxInferenceRoute[]>([])
  const [primaryRouteId, setPrimaryRouteId] = useState("")
  const [draftProvider, setDraftProvider] = useState("")
  const [draftModel, setDraftModel] = useState("")
  const [draftLabel, setDraftLabel] = useState("")
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [ollamaLoading, setOllamaLoading] = useState(false)

  const draftProviderIsOllama = draftProvider.toLowerCase().includes("ollama")
  const anyOllamaRoute = routes.some((route) => route.provider.toLowerCase().includes("ollama"))
  const shouldPollOllama = draftProviderIsOllama || anyOllamaRoute
  const primaryRoute = useMemo(
    () => routes.find((route) => route.id === primaryRouteId) || routes[0] || null,
    [routes, primaryRouteId]
  )

  const loadOllamaModels = useCallback(async () => {
    try {
      setOllamaLoading(true)
      const response = await fetch("/api/ollama/models", { cache: "no-store" })
      const data = await response.json()
      setOllamaModels(data.available && Array.isArray(data.models) ? data.models : [])
    } finally {
      setOllamaLoading(false)
    }
  }, [])

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setMessage("")
      const [inferenceResponse, configResponse] = await Promise.all([
        fetch("/api/inference", { cache: "no-store" }),
        fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference`, { cache: "no-store" }),
      ])
      const inferenceData = await inferenceResponse.json()
      const configData = await configResponse.json()
      if (!inferenceResponse.ok) throw new Error(inferenceData.error || "Failed to load providers")
      if (!configResponse.ok) throw new Error(configData.error || "Failed to load sandbox inference config")

      const nextProviders = Array.isArray(inferenceData.providers) ? inferenceData.providers : []
      const config = configData.config as SandboxInferenceConfig
      const fallbackProvider = inferenceData.gateway?.provider || nextProviders[0]?.name || ""
      const fallbackModel = inferenceData.gateway?.model || ""
      const nextRoutes = dedupeRoutes(Array.isArray(config?.routes) && config.routes.length > 0
        ? config.routes
        : fallbackProvider && fallbackModel
          ? [makeRoute(fallbackProvider, fallbackModel, "Gateway default")]
          : [])

      setProviders(nextProviders)
      setRoutes(nextRoutes)
      setPrimaryRouteId(config?.primaryRouteId || nextRoutes[0]?.id || "")
      setDraftProvider(fallbackProvider)
      setDraftModel("")
      setDraftLabel("")
      setUpdatedAt(config?.updatedAt || null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load sandbox inference config")
    } finally {
      setLoading(false)
    }
  }, [sandbox.id])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (!shouldPollOllama) return
    loadOllamaModels()
    const interval = window.setInterval(loadOllamaModels, 10000)
    return () => window.clearInterval(interval)
  }, [shouldPollOllama, loadOllamaModels])

  function addRoute(provider = draftProvider, model = draftModel, label = draftLabel) {
    const cleanProvider = provider.trim()
    const cleanModel = model.trim()
    if (!cleanProvider || !cleanModel) {
      setMessage("Choose a provider and model before adding a route.")
      return
    }
    const nextRoute = makeRoute(cleanProvider, cleanModel, label.trim())
    setRoutes((current) => {
      const next = dedupeRoutes([...current, nextRoute])
      if (!primaryRouteId) setPrimaryRouteId(nextRoute.id)
      return next
    })
    setDraftModel("")
    setDraftLabel("")
    setMessage("")
  }

  function updateRoute(id: string, updates: Partial<SandboxInferenceRoute>) {
    setRoutes((current) => current.map((route) => route.id === id ? { ...route, ...updates } : route))
  }

  function removeRoute(id: string) {
    setRoutes((current) => {
      const next = current.filter((route) => route.id !== id)
      if (primaryRouteId === id) setPrimaryRouteId(next[0]?.id || "")
      return next
    })
  }

  async function save() {
    try {
      setSaving(true)
      setMessage("")
      const cleanRoutes = dedupeRoutes(routes)
      if (cleanRoutes.length === 0) throw new Error("Add at least one provider/model route.")
      const primary = cleanRoutes.find((route) => route.id === primaryRouteId) || cleanRoutes[0]
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: primary.provider,
          primaryModel: primary.model,
          models: cleanRoutes.map((route) => route.model),
          routes: cleanRoutes,
          primaryRouteId: primary.id,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save sandbox inference config")
      const config = data.config as SandboxInferenceConfig
      setRoutes(config.routes)
      setPrimaryRouteId(config.primaryRouteId)
      setUpdatedAt(config.updatedAt)
      setMessage(`Saved ${config.routes.length} inference route${config.routes.length === 1 ? "" : "s"} for ${sandbox.name}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save sandbox inference config")
    } finally {
      setSaving(false)
    }
  }

  async function applyToContainer() {
    try {
      setApplying(true)
      setMessage("")
      const cleanRoutes = dedupeRoutes(routes)
      if (cleanRoutes.length === 0) throw new Error("Add at least one provider/model route before applying.")
      await save()
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxName: sandbox.name }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.note ? `${data.error}\n\n${data.note}` : data.error || "Failed to apply routes")
      setMessage(`${data.routesApplied} route${data.routesApplied === 1 ? "" : "s"} applied to ${sandbox.name}. ${data.note}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to apply routes")
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
            {sandbox.name} - INFERENCE ROUTES
          </h4>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">
            Enable multiple endpoint/model routes for this sandbox.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading || saving}
          className="px-3 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)] disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Loading inference routes...</div>
      ) : (
        <div className="mt-5 space-y-5">
          {primaryRoute && (
            <div className="metric p-4">
              <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Primary Route</p>
              <p className="mt-2 text-sm font-mono text-[var(--foreground)]">{primaryRoute.provider}</p>
              <p className="mt-1 text-xs font-mono text-[var(--foreground-dim)]">{primaryRoute.model}</p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(180px,240px)_minmax(0,1fr)_minmax(160px,220px)_auto] gap-3 items-end">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Endpoint</label>
              <select value={draftProvider} onChange={(event) => setDraftProvider(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]">
                <option value="">Select provider</option>
                {providers.map((item) => item.name ? <option key={item.name} value={item.name}>{item.name}</option> : null)}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Model</label>
              <input value={draftModel} onChange={(event) => setDraftModel(event.target.value)} placeholder="model id" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
            </div>
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Label</label>
              <input value={draftLabel} onChange={(event) => setDraftLabel(event.target.value)} placeholder="optional" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
            </div>
            <button onClick={() => addRoute()} className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)]">
              Add Route
            </button>
          </div>

          {draftProviderIsOllama && (
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
              <div className="flex items-center justify-between gap-4">
                <h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Ollama Models</h5>
                <button type="button" onClick={loadOllamaModels} disabled={ollamaLoading} className="px-3 py-2 rounded-sm bg-[var(--background)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)] disabled:opacity-50">
                  {ollamaLoading ? "Polling..." : "Poll"}
                </button>
              </div>
              {ollamaModels.length === 0 ? (
                <p className="mt-3 text-xs text-[var(--foreground-dim)]">No local Ollama models reported.</p>
              ) : (
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                  {ollamaModels.map((item) => (
                    <button key={item.name} type="button" onClick={() => addRoute(draftProvider, item.name, "Ollama")} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-left hover:border-[var(--nvidia-green)]">
                      <div className="text-xs font-mono text-[var(--foreground)]">{item.name}</div>
                      <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                        {[item.parameterSize, item.quantization, item.sizeLabel].filter(Boolean).join(" · ") || "local model"}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <h5 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Enabled Routes</h5>
            {routes.length === 0 ? (
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">No routes enabled for this sandbox.</div>
            ) : (
              <div className="space-y-2">
                {routes.map((route) => (
                  <div key={route.id} className="grid grid-cols-1 lg:grid-cols-[auto_minmax(160px,220px)_minmax(0,1fr)_minmax(140px,200px)_auto] gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 items-center">
                    <label className="flex items-center gap-2 text-xs text-[var(--foreground-dim)]">
                      <input type="radio" checked={primaryRouteId === route.id} onChange={() => setPrimaryRouteId(route.id)} />
                      Primary
                    </label>
                    <span className="text-xs font-mono text-[var(--foreground)]">{route.provider}</span>
                    <input value={route.model} onChange={(event) => updateRoute(route.id, { model: event.target.value })} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                    <input value={route.label} onChange={(event) => updateRoute(route.id, { label: event.target.value })} placeholder="label" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                    <div className="flex items-center justify-end gap-3">
                      <label className="flex items-center gap-2 text-xs text-[var(--foreground-dim)]">
                        <input type="checkbox" checked={route.enabled} onChange={(event) => updateRoute(route.id, { enabled: event.target.checked })} />
                        Enabled
                      </label>
                      <button onClick={() => removeRoute(route.id)} className="px-3 py-2 rounded-sm bg-[var(--background)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--status-stopped)] border border-[var(--border-subtle)]">
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className="px-4 py-2 rounded-sm bg-[var(--nvidia-green)] text-white text-xs font-mono uppercase tracking-wider disabled:opacity-50">
              {saving ? "Saving..." : "Save Sandbox Routes"}
            </button>
            <button onClick={applyToContainer} disabled={saving || applying} className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:border-[var(--nvidia-green)] border border-[var(--border-subtle)] disabled:opacity-50">
              {applying ? "Applying..." : "Apply to Running Container"}
            </button>
            {updatedAt && <span className="text-[11px] text-[var(--foreground-dim)]">Updated {new Date(updatedAt).toLocaleString()}</span>}
            {message && <span className="text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">{message}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
