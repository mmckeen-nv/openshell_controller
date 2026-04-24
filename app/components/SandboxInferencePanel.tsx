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

type SandboxInferenceConfig = {
  sandboxId: string
  provider: string
  primaryModel: string
  models: string[]
  updatedAt: string | null
}

function emptyConfig(sandboxId: string): SandboxInferenceConfig {
  return { sandboxId, provider: "", primaryModel: "", models: [], updatedAt: null }
}

function uniqueModels(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

export default function SandboxInferencePanel({ sandbox }: { sandbox: SandboxInventoryItem }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [provider, setProvider] = useState("")
  const [primaryModel, setPrimaryModel] = useState("")
  const [modelsText, setModelsText] = useState("")
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [ollamaLoading, setOllamaLoading] = useState(false)

  const isOllamaProvider = provider.toLowerCase().includes("ollama")
  const selectedModels = useMemo(
    () => uniqueModels([primaryModel, ...modelsText.split(/\r?\n/)]),
    [primaryModel, modelsText]
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
      const config = (configData.config ?? emptyConfig(sandbox.id)) as SandboxInferenceConfig
      const fallbackProvider = inferenceData.gateway?.provider || nextProviders[0]?.name || ""
      const fallbackModel = inferenceData.gateway?.model || ""
      const models = config.models.length > 0 ? config.models : (fallbackModel ? [fallbackModel] : [])

      setProviders(nextProviders)
      setProvider(config.provider || fallbackProvider)
      setPrimaryModel(config.primaryModel || models[0] || "")
      setModelsText(models.join("\n"))
      setUpdatedAt(config.updatedAt)
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
    if (!isOllamaProvider) return
    loadOllamaModels()
    const interval = window.setInterval(loadOllamaModels, 10000)
    return () => window.clearInterval(interval)
  }, [isOllamaProvider, loadOllamaModels])

  function toggleModel(modelName: string) {
    const next = selectedModels.includes(modelName)
      ? selectedModels.filter((item) => item !== modelName)
      : [...selectedModels, modelName]
    setModelsText(next.join("\n"))
    setPrimaryModel((current) => next.includes(current) ? current : next[0] || "")
  }

  async function save() {
    try {
      setSaving(true)
      setMessage("")
      const models = selectedModels
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          primaryModel: primaryModel || models[0],
          models,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to save sandbox inference config")
      const config = data.config as SandboxInferenceConfig
      setProvider(config.provider)
      setPrimaryModel(config.primaryModel)
      setModelsText(config.models.join("\n"))
      setUpdatedAt(config.updatedAt)
      setMessage(`Saved inference profile for ${sandbox.name}.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save sandbox inference config")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h4 className="text-sm font-semibold text-[var(--foreground)] uppercase tracking-wider">
            {sandbox.name} - INFERENCE PROFILE
          </h4>
          <p className="mt-1 text-xs text-[var(--foreground-dim)]">
            Container-specific provider and model selection.
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
        <div className="py-8 text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Loading inference profile...</div>
      ) : (
        <div className="mt-5 space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Endpoint Provider</label>
              <select value={provider} onChange={(event) => setProvider(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]">
                <option value="">Select provider</option>
                {providers.map((item) => item.name ? <option key={item.name} value={item.name}>{item.name}</option> : null)}
              </select>
            </div>
            <div className="space-y-2 lg:col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Primary Model</label>
              <input value={primaryModel} onChange={(event) => setPrimaryModel(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
            </div>
          </div>

          {isOllamaProvider && (
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
                    <button key={item.name} type="button" onClick={() => toggleModel(item.name)} className={`rounded-sm border p-3 text-left ${selectedModels.includes(item.name) ? "border-[var(--nvidia-green)] bg-[rgba(118,185,0,0.08)]" : "border-[var(--border-subtle)] bg-[var(--background)]"}`}>
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
            <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Model List</label>
            <textarea value={modelsText} onChange={(event) => setModelsText(event.target.value)} rows={4} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-sm font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]" />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className="px-4 py-2 rounded-sm bg-[var(--nvidia-green)] text-white text-xs font-mono uppercase tracking-wider disabled:opacity-50">
              {saving ? "Saving..." : "Save Sandbox Profile"}
            </button>
            {updatedAt && <span className="text-[11px] text-[var(--foreground-dim)]">Updated {new Date(updatedAt).toLocaleString()}</span>}
            {message && <span className="text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">{message}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
