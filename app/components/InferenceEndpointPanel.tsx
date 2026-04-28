"use client"

import { useCallback, useEffect, useMemo, useState } from "react"

type InferenceRoute = {
  configured: boolean
  provider: string | null
  model: string | null
  version: string | null
  timeout: string | null
}

type ProviderSummary = {
  id: string | null
  name: string | null
  type: string | null
  credentialKeys: string[]
  configKeys: string[]
}

type InferenceResponse = {
  gateway: InferenceRoute
  system: InferenceRoute
  providers: ProviderSummary[]
}

type OllamaModel = {
  name: string
  model: string
  modifiedAt: string | null
  sizeLabel: string | null
  family: string | null
  parameterSize: string | null
  quantization: string | null
}

const providerTypeOptions = [
  { value: "openai", label: "OpenAI compatible" },
  { value: "anthropic", label: "Anthropic" },
  { value: "generic", label: "Generic" },
]

function emptyRoute(): InferenceRoute {
  return { configured: false, provider: null, model: null, version: null, timeout: null }
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{children}</label>
}

export default function InferenceEndpointPanel() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [gateway, setGateway] = useState<InferenceRoute>(emptyRoute)
  const [system, setSystem] = useState<InferenceRoute>(emptyRoute)
  const [name, setName] = useState("vllm-local")
  const [type, setType] = useState("openai")
  const [model, setModel] = useState("nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4")
  const [baseUrl, setBaseUrl] = useState("http://host.docker.internal:8000/v1")
  const [credentialKey, setCredentialKey] = useState("OPENAI_API_KEY")
  const [apiKey, setApiKey] = useState("")
  const [route, setRoute] = useState<"gateway" | "system">("gateway")
  const [timeout, setTimeoutValue] = useState("0")
  const [noVerify, setNoVerify] = useState(true)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [ollamaLoading, setOllamaLoading] = useState(false)
  const [ollamaMessage, setOllamaMessage] = useState("")
  const [deletingProvider, setDeletingProvider] = useState<string | null>(null)

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.name === gateway.provider) ?? null,
    [providers, gateway.provider]
  )
  const isOllamaEndpoint = name.toLowerCase().includes("ollama") || baseUrl.includes("11434")

  async function load() {
    try {
      setLoading(true)
      setMessage("")
      const response = await fetch("/api/inference", { cache: "no-store" })
      const data = await response.json() as InferenceResponse & { error?: string }
      if (!response.ok) throw new Error(data.error || "Failed to load inference configuration")
      setGateway(data.gateway ?? emptyRoute())
      setSystem(data.system ?? emptyRoute())
      setProviders(Array.isArray(data.providers) ? data.providers : [])
      if (data.gateway?.provider) setName(data.gateway.provider)
      if (data.gateway?.model) setModel(data.gateway.model)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load inference configuration")
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const loadOllamaModels = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      setOllamaLoading(true)
      if (!silent) setOllamaMessage("")
      const response = await fetch("/api/ollama/models", { cache: "no-store" })
      const data = await response.json()
      if (!data.available) {
        setOllamaModels([])
        setOllamaMessage(data.error || "Ollama is not reachable")
        return
      }
      const models = Array.isArray(data.models) ? data.models : []
      setOllamaModels(models)
      setOllamaMessage(models.length > 0 ? `${models.length} Ollama model${models.length === 1 ? "" : "s"} available.` : "Ollama is reachable but has no models installed.")
      if (models[0]?.name) setModel((current) => current || models[0].name)
    } catch (error) {
      setOllamaModels([])
      setOllamaMessage(error instanceof Error ? error.message : "Failed to fetch Ollama models")
    } finally {
      setOllamaLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!isOllamaEndpoint) return
    loadOllamaModels({ silent: true })
    const interval = window.setInterval(() => loadOllamaModels({ silent: true }), 10000)
    return () => window.clearInterval(interval)
  }, [isOllamaEndpoint, loadOllamaModels])

  function selectProvider(provider: ProviderSummary) {
    if (!provider.name) return
    setName(provider.name)
    setType(provider.type || "openai")
    setCredentialKey(provider.credentialKeys[0] || "OPENAI_API_KEY")
    if (provider.name.toLowerCase().includes("ollama")) {
      setBaseUrl("http://host.docker.internal:11434/v1")
      setApiKey("")
    }
    setMessage(`Loaded ${provider.name}. Enter a model and save to make it active.`)
  }

  function useVllmPreset() {
    setName("vllm-local")
    setType("openai")
    setModel("nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4")
    setBaseUrl("http://host.docker.internal:8000/v1")
    setCredentialKey("OPENAI_API_KEY")
    setApiKey("")
    setRoute("gateway")
    setNoVerify(true)
    setMessage("vLLM preset loaded. Adjust the endpoint URL if your server is bound somewhere else, then save.")
  }

  async function saveEndpoint() {
    try {
      setSaving(true)
      setMessage("")
      const response = await fetch("/api/inference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          model,
          baseUrl,
          credentialKey,
          apiKey,
          route,
          timeout: Number(timeout || "0"),
          noVerify,
          makeActive: true,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save inference endpoint")
      setGateway(data.gateway ?? gateway)
      setSystem(data.system ?? system)
      setApiKey("")
      setMessage(`Inference endpoint '${name}' saved and routed to ${route === "system" ? "system" : "sandbox"} inference.`)
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save inference endpoint")
    } finally {
      setSaving(false)
    }
  }

  async function deleteProvider(providerName: string | null) {
    if (!providerName) return
    if (!window.confirm(`Delete inference provider '${providerName}'?`)) return
    try {
      setDeletingProvider(providerName)
      setMessage("")
      const response = await fetch("/api/inference", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: providerName }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to delete inference provider")
      setGateway(data.gateway ?? gateway)
      setSystem(data.system ?? system)
      setProviders(Array.isArray(data.providers) ? data.providers : [])
      if (name === providerName) setName("")
      setMessage(`Deleted inference provider '${providerName}'.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete inference provider")
    } finally {
      setDeletingProvider(null)
    }
  }

  return (
    <div className="panel p-8">
      <div className="flex items-start justify-between gap-6 border-b border-[var(--border-subtle)] pb-5">
        <div>
          <h2 className="text-lg font-semibold text-[var(--nvidia-green)] uppercase tracking-wider">
            INFERENCE ENDPOINTS
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-[var(--foreground-dim)]">
            Configure the OpenShell gateway route used by sandboxes through inference.local.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading || saving}
          className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-secondary)] disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="py-12 text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Loading inference routes...</div>
      ) : (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="metric p-4">
              <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Sandbox Route</p>
              <p className="mt-2 text-sm font-mono text-[var(--foreground)]">{gateway.configured ? gateway.provider : "not configured"}</p>
              <p className="mt-1 text-xs font-mono text-[var(--foreground-dim)]">{gateway.model || "No model selected"}</p>
              {gateway.timeout && <p className="mt-1 text-[11px] text-[var(--foreground-dim)]">Timeout {gateway.timeout}</p>}
            </div>
            <div className="metric p-4">
              <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">System Route</p>
              <p className="mt-2 text-sm font-mono text-[var(--foreground)]">{system.configured ? system.provider : "not configured"}</p>
              <p className="mt-1 text-xs font-mono text-[var(--foreground-dim)]">{system.model || "No model selected"}</p>
              {system.timeout && <p className="mt-1 text-[11px] text-[var(--foreground-dim)]">Timeout {system.timeout}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-6">
            <section className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <FieldLabel>Provider Name</FieldLabel>
                  <input value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Provider Type</FieldLabel>
                  <select value={type} onChange={(event) => setType(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]">
                    {providerTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel>Model</FieldLabel>
                  {isOllamaEndpoint && ollamaModels.length > 0 ? (
                    <select value={model} onChange={(event) => setModel(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]">
                      {ollamaModels.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                    </select>
                  ) : (
                    <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="provider/model-name" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                  )}
                </div>
                <div className="space-y-2 md:col-span-2">
                  <FieldLabel>Endpoint URL</FieldLabel>
                  <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Credential Env Key</FieldLabel>
                  <input value={credentialKey} onChange={(event) => setCredentialKey(event.target.value.toUpperCase())} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                </div>
                <div className="space-y-2">
                  <FieldLabel>API Key</FieldLabel>
                  <input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder={activeProvider ? "leave blank to keep stored key" : "stored in OpenShell provider"} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                </div>
                <div className="space-y-2">
                  <FieldLabel>Route</FieldLabel>
                  <select value={route} onChange={(event) => setRoute(event.target.value as "gateway" | "system")} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]">
                    <option value="gateway">Sandbox inference</option>
                    <option value="system">System inference</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <FieldLabel>Timeout Seconds</FieldLabel>
                  <input value={timeout} onChange={(event) => setTimeoutValue(event.target.value)} inputMode="numeric" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
                </div>
              </div>

              <label className="flex items-center gap-3 text-sm text-[var(--foreground)]">
                <input type="checkbox" checked={noVerify} onChange={(event) => setNoVerify(event.target.checked)} />
                Skip provider verification while saving
              </label>

              {isOllamaEndpoint && (
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h3 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Ollama Models</h3>
                      <p className="mt-1 text-xs text-[var(--foreground-dim)]">{ollamaMessage || "Polling local Ollama every 10 seconds."}</p>
                    </div>
                    <button type="button" onClick={() => loadOllamaModels()} disabled={ollamaLoading} className="px-3 py-2 rounded-sm bg-[var(--background)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-panel)] disabled:opacity-50">
                      {ollamaLoading ? "Polling..." : "Poll"}
                    </button>
                  </div>
                  {ollamaModels.length > 0 && (
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                      {ollamaModels.map((item) => (
                        <button key={item.name} type="button" onClick={() => setModel(item.name)} className={`rounded-sm border p-3 text-left ${model === item.name ? "border-[var(--nvidia-green)] bg-[rgba(118,185,0,0.08)]" : "border-[var(--border-subtle)] bg-[var(--background)]"}`}>
                          <div className="text-xs font-mono text-[var(--foreground)]">{item.name}</div>
                          <div className="mt-1 text-[11px] text-[var(--foreground-dim)]">
                            {[item.parameterSize, item.quantization, item.sizeLabel].filter(Boolean).join(" · ") || item.family || "local model"}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center gap-3">
                <button onClick={saveEndpoint} disabled={saving} className="px-4 py-2 rounded-sm bg-[var(--nvidia-green)] text-white text-xs font-mono uppercase tracking-wider disabled:opacity-50">
                  {saving ? "Saving..." : "Save Endpoint"}
                </button>
                <button type="button" onClick={useVllmPreset} disabled={saving} className="px-4 py-2 rounded-sm bg-[var(--background-tertiary)] text-[var(--foreground)] text-xs font-mono uppercase tracking-wider hover:bg-[var(--background-secondary)] disabled:opacity-50">
                  vLLM Preset
                </button>
                {message && <p className="text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">{message}</p>}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-xs uppercase tracking-wider text-[var(--foreground)]">Configured Providers</h3>
              {providers.length === 0 ? (
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">No providers configured.</div>
              ) : (
                <div className="space-y-2">
                  {providers.map((provider) => (
                    <div key={provider.name || provider.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3">
                      <button type="button" onClick={() => selectProvider(provider)} className="w-full text-left">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-sm font-mono text-[var(--foreground)]">{provider.name}</span>
                          {provider.name === gateway.provider && <span className="text-[10px] uppercase tracking-wider text-[var(--nvidia-green)]">active</span>}
                        </div>
                        <p className="mt-1 text-[11px] text-[var(--foreground-dim)]">{provider.type || "unknown"} · credentials {provider.credentialKeys.length} · config {provider.configKeys.length}</p>
                      </button>
                      <button type="button" onClick={() => deleteProvider(provider.name)} disabled={!provider.name || deletingProvider === provider.name} className="mt-3 px-3 py-2 rounded-sm border border-red-500/40 text-red-300 text-[10px] font-mono uppercase tracking-wider hover:bg-red-500/10 disabled:opacity-50">
                        {deletingProvider === provider.name ? "Deleting..." : "Delete"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
