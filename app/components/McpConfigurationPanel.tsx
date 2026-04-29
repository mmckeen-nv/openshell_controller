"use client"

import { useEffect, useMemo, useState } from "react"

type McpTransport = "stdio" | "http"

type McpCatalogEntry = {
  id: string
  name: string
  summary: string
  websiteUrl?: string
  transport: McpTransport
  command: string
  args: string[]
  env: Record<string, string>
  tags: string[]
}

type McpServerInstall = McpCatalogEntry & {
  installedAt: string
  updatedAt: string
  source: "catalog" | "custom" | "registry"
  enabled: boolean
  accessMode: "disabled" | "allow_all" | "allow_only"
  allowedSandboxIds: string[]
}

type McpResponse = {
  catalog: McpCatalogEntry[]
  servers: McpServerInstall[]
  config: Record<string, unknown>
  error?: string
}

type McpRegistry = {
  id: string
  name: string
  baseUrl: string
  description: string
  addedAt: string
}

type McpPreflightResult = {
  ok: boolean
  checkedAt: string
  toolCount: number
  tools: string[]
  durationMs: number
  error?: string
  diagnosis: {
    summary: string
    likelyCauses: string[]
    suggestedFixes: string[]
    confidence: "low" | "medium" | "high"
  }
}

type McpPreflightRepairResult = {
  attempted: boolean
  ok: boolean
  provider: "openai-compatible"
  model: string
  baseUrl: string
  summary: string
  changes: Array<{
    type: "file" | "launch"
    path?: string
    summary: string
  }>
  error?: string
}

type McpSandbox = {
  id: string
  name: string
  status: string
}

type McpConfigurationPanelProps = {
  sandboxes?: McpSandbox[]
}

const REGISTRY_PAGE_SIZE = 4

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{children}</label>
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <span
      title={typeof children === "string" ? children : undefined}
      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-[var(--border-subtle)] text-[10px] text-[var(--foreground-dim)]"
    >
      ?
    </span>
  )
}

function parseLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function parseEnv(value: string) {
  return Object.fromEntries(
    parseLines(value)
      .map((line) => {
        const [key, ...rest] = line.split("=")
        return [key?.trim() || "", rest.join("=").trim()]
      })
      .filter(([key]) => Boolean(key)),
  )
}

export default function McpConfigurationPanel({ sandboxes = [] }: McpConfigurationPanelProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState("")
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([])
  const [servers, setServers] = useState<McpServerInstall[]>([])
  const [config, setConfig] = useState<Record<string, unknown>>({ mcpServers: {} })
  const [customName, setCustomName] = useState("custom-tools")
  const [customSummary, setCustomSummary] = useState("Custom MCP server")
  const [customTransport, setCustomTransport] = useState<McpTransport>("stdio")
  const [customCommand, setCustomCommand] = useState("npx")
  const [customArgs, setCustomArgs] = useState("-y\n@modelcontextprotocol/server-memory")
  const [customEnv, setCustomEnv] = useState("")
  const [uploadFiles, setUploadFiles] = useState<File[]>([])
  const [uploadPaths, setUploadPaths] = useState<string[]>([])
  const [uploadArchive, setUploadArchive] = useState<File | null>(null)
  const [uploadRuntime, setUploadRuntime] = useState("python3")
  const [uploadEntryMode, setUploadEntryMode] = useState<"file" | "python-module" | "console-script">("file")
  const [uploadEntrypoint, setUploadEntrypoint] = useState("server.py")
  const [uploadRepair, setUploadRepair] = useState(true)
  const [repairSandboxId, setRepairSandboxId] = useState("")
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [editorText, setEditorText] = useState("")
  const [registrySearch, setRegistrySearch] = useState("github")
  const [registryResults, setRegistryResults] = useState<McpCatalogEntry[]>([])
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryPage, setRegistryPage] = useState(1)
  const [lastRegistrySearch, setLastRegistrySearch] = useState("")
  const [registries, setRegistries] = useState<McpRegistry[]>([])
  const [selectedRegistryId, setSelectedRegistryId] = useState("")
  const [registryName, setRegistryName] = useState("")
  const [registryUrl, setRegistryUrl] = useState("")
  const [registryDescription, setRegistryDescription] = useState("")
  const [registryPrompt, setRegistryPrompt] = useState("")
  const [preflightResults, setPreflightResults] = useState<Record<string, McpPreflightResult>>({})
  const [securityOpen, setSecurityOpen] = useState(true)
  const [openSecurityServers, setOpenSecurityServers] = useState<Record<string, boolean>>({})
  const [repoOpen, setRepoOpen] = useState(true)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState<"basics" | "launch" | "upload" | "review">("basics")

  const installedIds = useMemo(() => new Set(servers.map((server) => server.id)), [servers])
  const enabledCount = servers.filter((server) => server.enabled).length
  const configText = JSON.stringify(config, null, 2)
  const registryPageCount = Math.max(1, Math.ceil(registryResults.length / REGISTRY_PAGE_SIZE))
  const selectedRegistry = registries.find((registry) => registry.id === selectedRegistryId) || registries[0] || null
  const pagedRegistryResults = registryResults.slice(
    (registryPage - 1) * REGISTRY_PAGE_SIZE,
    registryPage * REGISTRY_PAGE_SIZE,
  )

  async function load() {
    try {
      setLoading(true)
      const [response, registryResponse] = await Promise.all([
        fetch("/api/mcp", { cache: "no-store" }),
        fetch("/api/mcp/registries", { cache: "no-store" }),
      ])
      const data = await response.json() as McpResponse
      const registryData = await registryResponse.json() as { registries?: McpRegistry[]; error?: string }
      if (!response.ok) throw new Error(data.error || "Failed to load MCP configuration")
      if (!registryResponse.ok) throw new Error(registryData.error || "Failed to load MCP registries")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : [])
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      const nextRegistries = Array.isArray(registryData.registries) ? registryData.registries : []
      setRegistries(nextRegistries)
      setSelectedRegistryId((current) => current && nextRegistries.some((registry) => registry.id === current) ? current : nextRegistries[0]?.id || "")
      setMessage("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load MCP configuration")
    } finally {
      setLoading(false)
    }
  }

  async function saveRegistry() {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/registries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: registryName, baseUrl: registryUrl, description: registryDescription }),
      })
      const data = await response.json() as { registry?: McpRegistry; registries?: McpRegistry[]; error?: string }
      if (!response.ok || !data.registry) throw new Error(data.error || "Failed to save MCP registry")
      const nextRegistries = Array.isArray(data.registries) ? data.registries : []
      setRegistries(nextRegistries)
      setSelectedRegistryId(data.registry.id)
      setRegistryName("")
      setRegistryUrl("")
      setRegistryDescription("")
      setRegistryPrompt("")
      setMessage(`${data.registry.name} registry added.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save MCP registry")
    } finally {
      setSaving(false)
    }
  }

  async function deleteRegistry(registry: McpRegistry) {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/registries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", registryId: registry.id }),
      })
      const data = await response.json() as { registries?: McpRegistry[]; error?: string }
      if (!response.ok) throw new Error(data.error || "Failed to delete MCP registry")
      const nextRegistries = Array.isArray(data.registries) ? data.registries : []
      setRegistries(nextRegistries)
      setSelectedRegistryId((current) => current === registry.id ? nextRegistries[0]?.id || "" : current)
      setRegistryResults([])
      setMessage(`${registry.name} registry deleted.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to delete MCP registry")
    } finally {
      setSaving(false)
    }
  }

  async function assistRegistry() {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/registries/assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: registryPrompt || `${registryName} ${registryUrl}`.trim() }),
      })
      const data = await response.json() as { suggestion?: Partial<McpRegistry>; error?: string }
      if (!response.ok || !data.suggestion) throw new Error(data.error || "Failed to generate registry suggestion")
      setRegistryName(data.suggestion.name || registryName)
      setRegistryUrl(data.suggestion.baseUrl || registryUrl)
      setRegistryDescription(data.suggestion.description || registryDescription)
      setMessage("Registry fields drafted from the running LLM endpoint.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to generate registry suggestion")
    } finally {
      setSaving(false)
    }
  }

  async function postUpdate(body: Record<string, unknown>, success: string) {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = await response.json() as McpResponse
      if (!response.ok) throw new Error(data.error || "Failed to update MCP configuration")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : catalog)
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      setMessage(success)
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update MCP configuration")
      return false
    } finally {
      setSaving(false)
    }
  }

  function sandboxAllowed(server: McpServerInstall, sandbox: McpSandbox) {
    return server.allowedSandboxIds.includes(sandbox.id) || server.allowedSandboxIds.includes(sandbox.name)
  }

  function toggleServerSandbox(server: McpServerInstall, sandbox: McpSandbox, allowed: boolean) {
    const current = new Set(server.allowedSandboxIds)
    current.delete(sandbox.id)
    current.delete(sandbox.name)
    if (allowed) current.add(sandbox.id)
    const hasOtherMcpAccess = servers.some((candidate) => candidate.id !== server.id && sandboxAllowed(candidate, sandbox))
    return postUpdate({
      action: "update-access",
      serverId: server.id,
      accessMode: "allow_only",
      allowedSandboxIds: Array.from(current),
    }, `${server.name} sandbox access updated.`).then((updated) => {
      if (!updated) return
      return syncSandboxBrokerConfig(sandbox, allowed || hasOtherMcpAccess ? "sync" : "revoke")
    })
  }

  async function syncSandboxBrokerConfig(sandbox: McpSandbox, action: "sync" | "revoke" = "sync") {
    try {
      setSaving(true)
      const response = await fetch(`/api/sandbox/${encodeURIComponent(sandbox.id)}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sandboxName: sandbox.name, action }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to sync MCP broker config")
      setMessage(data.note || (action === "revoke" ? `${sandbox.name} MCP broker config revoked.` : `${sandbox.name} MCP broker config synced.`))
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to sync MCP broker config")
    } finally {
      setSaving(false)
    }
  }

  async function syncAccessModeChange(server: McpServerInstall, accessMode: string) {
    const updated = await postUpdate({
      action: "update-access",
      serverId: server.id,
      accessMode,
    }, `${server.name} availability updated.`)
    if (!updated) return

    if (accessMode === "allow_all") {
      await Promise.all(sandboxes.map((sandbox) => syncSandboxBrokerConfig(sandbox)))
      return
    }

    if (accessMode === "disabled") {
      await Promise.all(sandboxes
        .filter((sandbox) => sandboxAllowed(server, sandbox))
        .map((sandbox) => {
          const hasOtherMcpAccess = servers.some((candidate) => candidate.id !== server.id && sandboxAllowed(candidate, sandbox))
          return syncSandboxBrokerConfig(sandbox, hasOtherMcpAccess ? "sync" : "revoke")
        }))
    }
  }

  async function setServerEnabled(server: McpServerInstall, enabled: boolean) {
    const updated = await postUpdate({
      action: "update-access",
      serverId: server.id,
      enabled,
    }, `${server.name} ${enabled ? "enabled" : "disabled"}.`)
    if (!updated) return

    const affectedSandboxes = sandboxes.filter((sandbox) => sandboxAllowed(server, sandbox))
    await Promise.all(affectedSandboxes.map((sandbox) => {
      const hasOtherMcpAccess = servers.some((candidate) => candidate.id !== server.id && sandboxAllowed(candidate, sandbox))
      return syncSandboxBrokerConfig(sandbox, enabled || hasOtherMcpAccess ? "sync" : "revoke")
    }))
  }

  function editableServerJson(server: McpServerInstall) {
    return JSON.stringify({
      id: server.id,
      name: server.name,
      summary: server.summary,
      websiteUrl: server.websiteUrl || "",
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      tags: server.tags,
      enabled: server.enabled,
      accessMode: server.accessMode,
      allowedSandboxIds: server.allowedSandboxIds,
      source: server.source,
    }, null, 2)
  }

  function serverPayloadFromJson(text: string, fallbackId = "uploaded-server") {
    const parsed = JSON.parse(text)
    const firstMcpEntry = parsed?.mcpServers && typeof parsed.mcpServers === "object"
      ? Object.entries(parsed.mcpServers)[0]
      : null
    const id = firstMcpEntry?.[0] || parsed?.id || parsed?.name || fallbackId
    const body = firstMcpEntry?.[1] && typeof firstMcpEntry[1] === "object" ? firstMcpEntry[1] as Record<string, unknown> : parsed
    const command = typeof body?.command === "string"
      ? body.command
      : typeof body?.url === "string"
        ? body.url
        : typeof parsed?.command === "string"
          ? parsed.command
          : typeof parsed?.url === "string"
            ? parsed.url
            : ""
    const transport = body?.url || parsed?.transport === "http" ? "http" : "stdio"

    return {
      action: "install",
      id,
      name: parsed?.name || id,
      summary: parsed?.summary || "Uploaded MCP server",
      websiteUrl: parsed?.websiteUrl || "",
      transport,
      command,
      args: Array.isArray(body?.args) ? body.args : Array.isArray(parsed?.args) ? parsed.args : [],
      env: typeof body?.env === "object" && body.env ? body.env : typeof body?.headers === "object" && body.headers ? body.headers : parsed?.env || {},
      tags: Array.isArray(parsed?.tags) ? parsed.tags : ["uploaded"],
      source: parsed?.source || "custom",
      enabled: typeof parsed?.enabled === "boolean" ? parsed.enabled : true,
      accessMode: parsed?.accessMode,
      allowedSandboxIds: parsed?.allowedSandboxIds,
    }
  }

  function chooseUploadDirectory(fileList: FileList | null) {
    const files = Array.from(fileList || [])
    setUploadFiles(files)
    setUploadPaths(files.map((file) => {
      const withRelativePath = file as File & { webkitRelativePath?: string }
      return withRelativePath.webkitRelativePath || file.name
    }))
    if (files.length > 0) setUploadArchive(null)
  }

  function chooseUploadArchive(file: File | null) {
    setUploadArchive(file)
    if (file) {
      setUploadFiles([])
      setUploadPaths([])
    }
  }

  function summarizePreflight(preflight: McpPreflightResult) {
    if (preflight.ok) {
      return `${preflight.diagnosis.summary}${preflight.tools.length > 0 ? ` Tools: ${preflight.tools.join(", ")}.` : ""}`
    }
    const causes = preflight.diagnosis.likelyCauses.length > 0
      ? `\nLikely: ${preflight.diagnosis.likelyCauses.join(" ")}`
      : ""
    const fixes = preflight.diagnosis.suggestedFixes.length > 0
      ? `\nTry: ${preflight.diagnosis.suggestedFixes.join(" ")}`
      : ""
    return `${preflight.diagnosis.summary}\n${preflight.error || "MCP tool discovery failed."}${causes}${fixes}`
  }

  function summarizeRepair(repair?: McpPreflightRepairResult | null) {
    if (!repair?.attempted) return ""
    const changeSummary = repair.changes.length > 0
      ? `\nChanged: ${repair.changes.map((change) => change.path ? `${change.path}: ${change.summary}` : change.summary).join(" ")}`
      : ""
    const route = repair.model ? `\nRepair model: ${repair.model}` : ""
    const error = repair.error ? `\nRepair error: ${repair.error}` : ""
    return `\nLLM repair ${repair.ok ? "applied" : "did not apply changes"}: ${repair.summary}${changeSummary}${route}${error}`
  }

  async function preflightServer(server: McpServerInstall) {
    try {
      setSaving(true)
      const response = await fetch("/api/mcp/preflight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: server.id }),
      })
      const data = await response.json() as { preflight?: McpPreflightResult; error?: string }
      if (!response.ok || !data.preflight) throw new Error(data.error || "Failed to preflight MCP server")
      setPreflightResults((current) => ({ ...current, [server.id]: data.preflight as McpPreflightResult }))
      setMessage(`${server.name} preflight ${data.preflight.ok ? "passed" : "failed"}.\n${summarizePreflight(data.preflight)}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to preflight MCP server")
    } finally {
      setSaving(false)
    }
  }

  async function uploadServer() {
    try {
      if (!uploadArchive && uploadFiles.length === 0) {
        setMessage("Choose a server directory or archive before uploading.")
        return
      }
      setSaving(true)
      const form = new FormData()
      form.set("id", customName)
      form.set("name", customName)
      form.set("summary", customSummary)
      form.set("runtime", uploadRuntime)
      form.set("entryMode", uploadEntryMode)
      form.set("entrypoint", uploadEntrypoint)
      form.set("args", customArgs)
      form.set("env", customEnv)
      form.set("repair", uploadRepair ? "true" : "false")
      if (repairSandboxId) form.set("sandboxId", repairSandboxId)
      if (uploadArchive) {
        form.set("archive", uploadArchive)
      } else {
        uploadFiles.forEach((file, index) => {
          form.append("files", file)
          form.append("paths", uploadPaths[index] || file.name)
        })
      }
      const response = await fetch("/api/mcp/upload", { method: "POST", body: form })
      const data = await response.json() as McpResponse & { dependencyInstall?: { kind?: string; logs?: string[] }; preflight?: McpPreflightResult; repair?: McpPreflightRepairResult; server?: McpServerInstall }
      if (!response.ok) throw new Error(data.error || "Failed to upload MCP server")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : catalog)
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      if (data.preflight && data.server?.id) {
        setPreflightResults((current) => ({ ...current, [data.server!.id]: data.preflight as McpPreflightResult }))
      }
      setUploadFiles([])
      setUploadPaths([])
      setUploadArchive(null)
      const installKind = data.dependencyInstall?.kind || "generic"
      const installLogCount = data.dependencyInstall?.logs?.filter(Boolean).length || 0
      const preflightNote = data.preflight
        ? `\nPreflight ${data.preflight.ok ? "passed" : "failed; server saved disabled"}.\n${summarizePreflight(data.preflight)}`
        : ""
      setMessage(`${customName} uploaded. ${installKind === "generic" ? "No dependency bootstrap was needed." : `${installKind} dependencies bootstrapped${installLogCount > 0 ? ` with ${installLogCount} install step${installLogCount === 1 ? "" : "s"}` : ""}.`}${summarizeRepair(data.repair)}${preflightNote}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to upload MCP server")
    } finally {
      setSaving(false)
    }
  }

  function startEditingServer(server: McpServerInstall) {
    setEditingServerId(server.id)
    setEditorText(editableServerJson(server))
  }

  async function saveEditedServer() {
    try {
      const payload = serverPayloadFromJson(editorText, editingServerId || "edited-server")
      await postUpdate(payload, `${String(payload.name || payload.id)} updated.`)
      setEditingServerId(null)
      setEditorText("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to save MCP server JSON")
    }
  }

  async function searchRegistry() {
    const query = registrySearch.trim()
    if (!selectedRegistry) {
      setMessage("Add an MCP Registry before searching.")
      return
    }
    try {
      setRegistryLoading(true)
      setRegistryResults([])
      setRegistryPage(1)
      setLastRegistrySearch(query)
      const params = new URLSearchParams({ search: query, limit: "24", baseUrl: selectedRegistry.baseUrl })
      const response = await fetch(`/api/mcp/registry?${params}`, { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to search MCP registry")
      const results = Array.isArray(data.results) ? data.results : []
      setRegistryResults(results)
      setMessage(results.length > 0 ? `Found ${results.length} server${results.length === 1 ? "" : "s"} in ${selectedRegistry.name}.` : `${selectedRegistry.name} had no matches for that search.`)
    } catch (error) {
      setRegistryResults([])
      setMessage(error instanceof Error ? error.message : "Failed to search MCP registry")
    } finally {
      setRegistryLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div className="space-y-6">
      <div className="panel overflow-hidden">
        <div className="panel-header flex items-start justify-between gap-6 p-6 max-md:flex-col">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--nvidia-green)]">Model Context Protocol</p>
            <h1 className="mt-1 text-xl font-semibold uppercase tracking-wider text-[var(--foreground)]">MCP CONFIGURATION</h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--foreground-dim)]">
              Install MCP server definitions for local tools, files, and remote context providers.
            </p>
          </div>
          <button onClick={load} disabled={loading || saving} className="action-button px-4 py-2">
            Refresh
          </button>
        </div>
        <div className="grid grid-cols-1 gap-px bg-[var(--border-subtle)] sm:grid-cols-3">
          <div className="bg-[var(--surface-raised)] p-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Installed</p>
            <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{servers.length} servers</p>
          </div>
          <div className="bg-[var(--surface-raised)] p-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Enabled</p>
            <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{enabledCount} active</p>
          </div>
          <div className="bg-[var(--surface-raised)] p-4">
            <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Catalog</p>
            <p className="mt-1 font-mono text-sm text-[var(--foreground)]">{catalog.length} presets</p>
          </div>
        </div>
      </div>

      {message && (
        <div className="panel p-4 text-xs text-[var(--foreground-dim)] whitespace-pre-wrap">
          {message}
        </div>
      )}

      {loading ? (
        <div className="panel p-8 text-xs uppercase tracking-wider text-[var(--foreground-dim)]">Loading MCP servers...</div>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <section className="space-y-6">
            <div className="panel p-6">
              <button
                type="button"
                onClick={() => setSecurityOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]"
                aria-expanded={securityOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">MCP Security</h2>
                  <p className="mt-1 text-xs text-[var(--foreground-dim)]">Control which installed MCP servers are available to sandboxes.</p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-sm text-[var(--foreground)]">
                  {securityOpen ? "-" : "+"}
                </span>
              </button>
              {securityOpen && (
                <div className="mt-5 space-y-3 border-t border-[var(--border-subtle)] pt-5">
                  {servers.length === 0 ? (
                    <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                      Install an MCP server before configuring sandbox access.
                    </div>
                  ) : servers.map((server) => {
                    const expanded = openSecurityServers[server.id] !== false
                    return (
                      <div key={server.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)]">
                        <button
                          type="button"
                          onClick={() => setOpenSecurityServers((current) => ({ ...current, [server.id]: !expanded }))}
                          className="flex w-full items-start justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]"
                          aria-expanded={expanded}
                        >
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="truncate text-sm font-mono font-semibold text-[var(--foreground)]">{server.name}</span>
                              <span className={`status-chip px-2 py-1 ${server.enabled ? "bg-[var(--status-running-bg)] text-[var(--status-running)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending)]"}`}>
                                {server.enabled ? "enabled" : "disabled"}
                              </span>
                            </span>
                            <span className="mt-2 block break-all font-mono text-[11px] text-[var(--foreground-dim)]">{server.command} {server.args.join(" ")}</span>
                          </span>
                          <span className="text-sm text-[var(--foreground)]">{expanded ? "-" : "+"}</span>
                        </button>

                        {expanded && (
                          <div className="border-t border-[var(--border-subtle)] p-4">
                            <div className="flex gap-2 max-sm:[&>button]:flex-1">
                              <button onClick={() => setServerEnabled(server, true)} disabled={saving || server.enabled} className="action-button px-3 py-2">Enable</button>
                              <button onClick={() => setServerEnabled(server, false)} disabled={saving || !server.enabled} className="action-button px-3 py-2">Disable</button>
                            </div>
                            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                              <div className="space-y-2">
                                <FieldLabel>Availability</FieldLabel>
                                <select value={server.accessMode} onChange={(event) => syncAccessModeChange(server, event.target.value)} disabled={saving} className="field-control w-full px-3 py-2 text-xs font-mono uppercase tracking-wider">
                                  <option value="disabled">Disabled</option>
                                  <option value="allow_all">Allow All</option>
                                  <option value="allow_only">Allow Only</option>
                                </select>
                              </div>
                              <div className={server.accessMode === "allow_only" ? "space-y-2" : "opacity-50"}>
                                <FieldLabel>Allowed Sandboxes</FieldLabel>
                                {sandboxes.length === 0 ? (
                                  <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-xs text-[var(--foreground-dim)]">No sandboxes detected.</div>
                                ) : (
                                  <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                    {sandboxes.map((sandbox) => (
                                      <label key={sandbox.id} className="flex items-center justify-between gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-xs">
                                        <span className="min-w-0">
                                          <span className="block truncate font-mono text-[var(--foreground)]">{sandbox.name}</span>
                                          <span className="mt-1 block truncate text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{sandbox.status}</span>
                                        </span>
                                        <input type="checkbox" checked={sandboxAllowed(server, sandbox)} disabled={saving || server.accessMode !== "allow_only"} onChange={(event) => toggleServerSandbox(server, sandbox, event.target.checked)} className="h-4 w-4 accent-[var(--nvidia-green)]" />
                                      </label>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="panel p-6">
              <button
                type="button"
                onClick={() => setRepoOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]"
                aria-expanded={repoOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">MCP Repo Search and Preconfigured Servers</h2>
                  <p className="mt-1 text-xs text-[var(--foreground-dim)]">Choose a registry, search installable MCP servers, or install a preset.</p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-sm text-[var(--foreground)]">
                  {repoOpen ? "-" : "+"}
                </span>
              </button>
              {repoOpen && (
                <div className="mt-5 space-y-5 border-t border-[var(--border-subtle)] pt-5">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel>Available Registries</FieldLabel>
                      {selectedRegistry && (
                        <a href={selectedRegistry.baseUrl} target="_blank" rel="noreferrer" className="text-[11px] font-mono uppercase tracking-wider text-[var(--nvidia-green)] hover:underline">Open</a>
                      )}
                    </div>
                    {registries.length === 0 ? (
                      <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                        Add an MCP Registry
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                        {registries.map((registry) => {
                          const selected = registry.id === selectedRegistryId
                          return (
                            <button
                              key={registry.id}
                              type="button"
                              onClick={() => { setSelectedRegistryId(registry.id); setRegistryResults([]) }}
                              className={`rounded-sm border p-3 text-left ${selected ? "border-[var(--nvidia-green)] bg-[var(--status-running-bg)]" : "border-[var(--border-subtle)] bg-[var(--background)]"}`}
                            >
                              <span className="block truncate text-xs font-mono font-semibold text-[var(--foreground)]">{registry.name}</span>
                              <span className="mt-1 block truncate text-[11px] text-[var(--foreground-dim)]">{registry.baseUrl}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {selectedRegistry && (
                      <button onClick={() => deleteRegistry(selectedRegistry)} disabled={saving} className="action-button px-3 py-2">
                        Delete Selected Registry
                      </button>
                    )}
                  </div>

                  <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><FieldLabel>Registry Name</FieldLabel><FieldHint>Name shown in the registry selector.</FieldHint></div>
                        <input value={registryName} onChange={(event) => setRegistryName(event.target.value)} placeholder="Company MCP Repo" className="field-control w-full px-3 py-2 text-sm" />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2"><FieldLabel>Registry URL</FieldLabel><FieldHint>Root URL for a registry that exposes /v0/servers.</FieldHint></div>
                        <input value={registryUrl} onChange={(event) => setRegistryUrl(event.target.value)} placeholder="https://registry.example.com" className="field-control w-full px-3 py-2 text-sm font-mono" />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <div className="flex items-center gap-2"><FieldLabel>LLM Registry Assist</FieldLabel><FieldHint>Describe a registry and the running LLM endpoint drafts the fields.</FieldHint></div>
                        <textarea value={registryPrompt} onChange={(event) => setRegistryPrompt(event.target.value)} rows={3} placeholder="Add the Acme internal MCP registry at https://mcp.acme.example" className="field-control w-full resize-y px-3 py-2 text-sm" />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <div className="flex items-center gap-2"><FieldLabel>Description</FieldLabel><FieldHint>Short operator-facing note for this registry.</FieldHint></div>
                        <input value={registryDescription} onChange={(event) => setRegistryDescription(event.target.value)} className="field-control w-full px-3 py-2 text-sm" />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button onClick={assistRegistry} disabled={saving || (!registryPrompt.trim() && !registryUrl.trim())} className="action-button px-3 py-2">Draft With LLM</button>
                      <button onClick={saveRegistry} disabled={saving || !registryUrl.trim()} className="rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">Add Registry</button>
                    </div>
                  </div>

                  <div className="flex gap-3 max-sm:flex-col">
                    <input value={registrySearch} onChange={(event) => setRegistrySearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") searchRegistry() }} placeholder="Search GitHub, Slack, filesystem, Postgres..." className="field-control min-w-0 flex-1 px-3 py-2 text-sm" />
                    <button onClick={searchRegistry} disabled={registryLoading || saving || !selectedRegistry} className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">
                      {registryLoading ? "Searching..." : "Search"}
                    </button>
                  </div>
                  {registryResults.length > 0 && (
                    <>
                      <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4 max-sm:flex-col max-sm:items-start">
                        <p className="text-xs text-[var(--foreground-dim)]">
                          Showing {((registryPage - 1) * REGISTRY_PAGE_SIZE) + 1}-{Math.min(registryPage * REGISTRY_PAGE_SIZE, registryResults.length)} of {registryResults.length}
                          {lastRegistrySearch ? ` for "${lastRegistrySearch}"` : ""}{selectedRegistry ? ` in ${selectedRegistry.name}` : ""}
                        </p>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setRegistryPage((page) => Math.max(1, page - 1))} disabled={registryPage === 1} className="action-button px-3 py-2">Prev</button>
                          <span className="min-w-16 text-center text-xs font-mono text-[var(--foreground-dim)]">{registryPage} / {registryPageCount}</span>
                          <button onClick={() => setRegistryPage((page) => Math.min(registryPageCount, page + 1))} disabled={registryPage === registryPageCount} className="action-button px-3 py-2">Next</button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                        {pagedRegistryResults.map((entry, index) => {
                          const installed = installedIds.has(entry.id)
                          return (
                            <div key={`${entry.id}-${entry.command}-${entry.args.join("|")}-${index}`} className="metric flex min-h-44 flex-col p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <h3 className="truncate text-sm font-semibold text-[var(--foreground)]">{entry.name}</h3>
                                  <p className="mt-2 text-xs leading-5 text-[var(--foreground-dim)]">{entry.summary}</p>
                                </div>
                                <span className="status-chip bg-[var(--status-pending-bg)] px-2 py-1 text-[var(--status-pending)]">{entry.transport}</span>
                              </div>
                              <div className="mt-3 min-w-0 rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-2 font-mono text-[11px] text-[var(--foreground-dim)]">
                                <span className="text-[var(--foreground)]">{entry.command}</span> {entry.args.join(" ")}
                              </div>
                              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                                <p className="truncate text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{entry.tags.join(" / ")}</p>
                                <button onClick={() => postUpdate({ action: "install", ...entry, source: "registry" }, installed ? `${entry.name} refreshed from registry.` : `${entry.name} installed from registry.`)} disabled={saving} className={installed ? "action-button px-3 py-2" : "rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"}>
                                  {installed ? "Refresh" : "Install"}
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}

                  <button type="button" onClick={() => setCatalogOpen((open) => !open)} className="flex w-full items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]" aria-expanded={catalogOpen}>
                    <div>
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Preconfigured Servers</h3>
                      <p className="mt-1 text-xs text-[var(--foreground-dim)]">Presets install as MCP command definitions; clients start them when needed.</p>
                    </div>
                    <span className="text-sm text-[var(--foreground)]">{catalogOpen ? "-" : "+"}</span>
                  </button>
                  {catalogOpen && (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                      {catalog.map((entry) => {
                        const installed = installedIds.has(entry.id)
                        return (
                          <div key={entry.id} className="metric flex min-h-44 flex-col p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">{entry.name}</h3>
                                <p className="mt-2 text-xs leading-5 text-[var(--foreground-dim)]">{entry.summary}</p>
                                {entry.websiteUrl && <a href={entry.websiteUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] font-mono uppercase tracking-wider text-[var(--nvidia-green)] hover:underline">Setup Guide</a>}
                              </div>
                              <span className="status-chip bg-[var(--status-pending-bg)] px-2 py-1 text-[var(--status-pending)]">{entry.transport}</span>
                            </div>
                            <div className="mt-3 min-w-0 rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-2 font-mono text-[11px] text-[var(--foreground-dim)]">
                              <span className="text-[var(--foreground)]">{entry.command}</span> {entry.args.join(" ")}
                            </div>
                            <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                              <p className="truncate text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{entry.tags.join(" / ")}</p>
                              <button onClick={() => postUpdate({ action: "install", id: entry.id }, installed ? `${entry.name} refreshed.` : `${entry.name} installed.`)} disabled={saving} className={installed ? "action-button px-3 py-2" : "rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"}>
                                {installed ? "Refresh" : "Install"}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="panel p-6">
              <button
                type="button"
                onClick={() => setCustomOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]"
                aria-expanded={customOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Server Install Wizard</h2>
                  <p className="mt-1 text-xs text-[var(--foreground-dim)]">Install a command, HTTP endpoint, or uploaded MCP bundle with assisted preflight repair.</p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-sm text-[var(--foreground)]">
                  {customOpen ? "-" : "+"}
                </span>
              </button>
              {customOpen && (
                <div className="mt-5 border-t border-[var(--border-subtle)] pt-5">
                  <div className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-4">
                    {(["basics", "launch", "upload", "review"] as const).map((step) => (
                      <button
                        key={step}
                        type="button"
                        onClick={() => setWizardStep(step)}
                        className={`rounded-sm border px-3 py-2 text-xs font-mono uppercase tracking-wider ${wizardStep === step ? "border-[var(--nvidia-green)] bg-[var(--status-running-bg)] text-[var(--foreground)]" : "border-[var(--border-subtle)] bg-[var(--background)] text-[var(--foreground-dim)]"}`}
                      >
                        {step}
                      </button>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Name</FieldLabel><FieldHint>Stable display name and default id for this MCP server.</FieldHint></div>
                      <input value={customName} onChange={(event) => setCustomName(event.target.value)} className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Transport</FieldLabel><FieldHint>Use stdio for local commands, HTTP for remote streamable MCP endpoints.</FieldHint></div>
                      <select value={customTransport} onChange={(event) => setCustomTransport(event.target.value as McpTransport)} className="field-control w-full px-3 py-2 text-sm font-mono">
                        <option value="stdio">stdio</option>
                        <option value="http">http</option>
                      </select>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <div className="flex items-center gap-2"><FieldLabel>Summary</FieldLabel><FieldHint>Short note shown in the installed server list.</FieldHint></div>
                      <input value={customSummary} onChange={(event) => setCustomSummary(event.target.value)} className="field-control w-full px-3 py-2 text-sm" />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <div className="flex items-center gap-2"><FieldLabel>{customTransport === "http" ? "URL" : "Command"}</FieldLabel><FieldHint>{customTransport === "http" ? "Full remote MCP endpoint URL." : "Executable available to the controller, such as npx, uvx, node, or python."}</FieldHint></div>
                      <input value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} placeholder={customTransport === "http" ? "https://mcp.example.com/mcp" : "npx, uvx, node, python"} className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Args</FieldLabel><FieldHint>One argument per line, passed to the command in order.</FieldHint></div>
                      <textarea value={customArgs} onChange={(event) => setCustomArgs(event.target.value)} rows={6} className="field-control w-full resize-y px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>{customTransport === "http" ? "Headers" : "Env"}</FieldLabel><FieldHint>KEY=value lines. HTTP entries become headers; stdio entries become environment variables.</FieldHint></div>
                      <textarea value={customEnv} onChange={(event) => setCustomEnv(event.target.value)} rows={6} placeholder={customTransport === "http" ? "Authorization=Bearer token" : "API_KEY=value\nBASE_URL=http://localhost:3000"} className="field-control w-full resize-y px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Upload Runtime</FieldLabel><FieldHint>Runtime used to bootstrap uploaded bundles before preflight.</FieldHint></div>
                      <input value={uploadRuntime} onChange={(event) => setUploadRuntime(event.target.value)} placeholder="python3, node, uv, uvx" className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Upload Launch Mode</FieldLabel><FieldHint>How the uploaded server should start after dependencies are installed.</FieldHint></div>
                      <select value={uploadEntryMode} onChange={(event) => setUploadEntryMode(event.target.value as "file" | "python-module" | "console-script")} className="field-control w-full px-3 py-2 text-sm font-mono">
                        <option value="file">File</option>
                        <option value="python-module">Python module</option>
                        <option value="console-script">Console script</option>
                      </select>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Upload Entrypoint</FieldLabel><FieldHint>File path, Python module name, or installed console script to launch.</FieldHint></div>
                      <input value={uploadEntrypoint} onChange={(event) => setUploadEntrypoint(event.target.value)} placeholder={uploadEntryMode === "python-module" ? "isaac_mcp_poc.server" : uploadEntryMode === "console-script" ? "isaac-mcp-poc" : "server.py, src/server.py, index.js"} className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Preflight Repair</FieldLabel><FieldHint>When preflight fails, ask the running LLM endpoint for a bounded repair and run preflight again.</FieldHint></div>
                      <label className="flex min-h-10 items-center justify-between gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)]">
                        <span>Use sandbox LLM on failed uploads</span>
                        <input
                          type="checkbox"
                          checked={uploadRepair}
                          onChange={(event) => setUploadRepair(event.target.checked)}
                          className="h-4 w-4 accent-[var(--nvidia-green)]"
                        />
                      </label>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center gap-2"><FieldLabel>Repair Route</FieldLabel><FieldHint>Optional sandbox whose configured model should be used for repair assistance.</FieldHint></div>
                      <select
                        value={repairSandboxId}
                        onChange={(event) => setRepairSandboxId(event.target.value)}
                        disabled={!uploadRepair}
                        className="field-control w-full px-3 py-2 text-sm font-mono"
                      >
                        <option value="">Default controller model</option>
                        {sandboxes.map((sandbox) => (
                          <option key={sandbox.id} value={sandbox.id}>{sandbox.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => postUpdate({
                        action: "install",
                        id: customName,
                        name: customName,
                        summary: customSummary,
                        transport: customTransport,
                        command: customCommand,
                        args: parseLines(customArgs),
                        env: parseEnv(customEnv),
                        tags: ["custom"],
                        source: "custom",
                      }, `${customName} installed.`)}
                      disabled={saving}
                      className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"
                    >
                      Install Server Command
                    </button>
                    <label className="action-button cursor-pointer px-4 py-2">
                      Choose Directory
                      <input
                        type="file"
                        multiple
                        onChange={(event) => chooseUploadDirectory(event.target.files)}
                        className="sr-only"
                        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                      />
                    </label>
                    <label className="action-button cursor-pointer px-4 py-2">
                      Choose Archive
                      <input
                        type="file"
                        accept=".zip,.tgz,.tar.gz,.tar,application/zip,application/gzip,application/x-tar"
                        onChange={(event) => chooseUploadArchive(event.target.files?.[0] || null)}
                        className="sr-only"
                      />
                    </label>
                    <button
                      onClick={uploadServer}
                      disabled={saving || (!uploadArchive && uploadFiles.length === 0)}
                      className="action-button px-4 py-2"
                    >
                      Upload Server
                    </button>
                    {(uploadArchive || uploadFiles.length > 0) && (
                      <span className="text-xs font-mono text-[var(--foreground-dim)]">
                        {uploadArchive ? uploadArchive.name : `${uploadFiles.length} file${uploadFiles.length === 1 ? "" : "s"}`}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-6">
            <div className="panel p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Installed Servers</h2>
              <div className="mt-4 space-y-3">
                {servers.length === 0 ? (
                  <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                    No MCP servers installed yet.
                  </div>
                ) : servers.map((server) => (
                  <div key={server.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-mono font-semibold text-[var(--foreground)]">{server.name}</h3>
                        <p className="mt-1 text-[11px] text-[var(--foreground-dim)]">{server.source} / {server.transport}</p>
                      </div>
                      <span className={`status-chip px-2 py-1 ${server.enabled ? "bg-[var(--status-running-bg)] text-[var(--status-running)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending)]"}`}>
                        {server.enabled ? "enabled" : "disabled"}
                      </span>
                    </div>
                    <p className="mt-3 break-all font-mono text-[11px] text-[var(--foreground-dim)]">{server.command} {server.args.join(" ")}</p>
                    <div className="mt-4 flex gap-2">
                      <button onClick={() => startEditingServer(server)} disabled={saving} className="action-button flex-1 px-3 py-2">
                        Edit
                      </button>
                      <button onClick={() => preflightServer(server)} disabled={saving} className="action-button flex-1 px-3 py-2">
                        Preflight
                      </button>
                      <button onClick={() => setServerEnabled(server, !server.enabled)} disabled={saving} className="action-button flex-1 px-3 py-2">
                        {server.enabled ? "Disable" : "Enable"}
                      </button>
                      <button onClick={() => postUpdate({ action: "uninstall", serverId: server.id }, `${server.name} removed.`)} disabled={saving} className="action-button flex-1 px-3 py-2">
                        Remove
                      </button>
                    </div>
                    {preflightResults[server.id] && (
                      <div className={`mt-4 rounded-sm border p-3 text-xs ${preflightResults[server.id].ok ? "border-[var(--status-running)] bg-[var(--status-running-bg)] text-[var(--status-running)]" : "border-[var(--status-error)] bg-[var(--status-error-bg)] text-[var(--status-error)]"}`}>
                        <div className="font-mono uppercase tracking-wider">
                          Preflight {preflightResults[server.id].ok ? "passed" : "failed"} / {preflightResults[server.id].durationMs} ms
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-[11px] leading-5">{summarizePreflight(preflightResults[server.id])}</p>
                      </div>
                    )}
                    {editingServerId === server.id && (
                      <div className="mt-4 border-t border-[var(--border-subtle)] pt-4">
                        <div className="flex items-center justify-between gap-3">
                          <FieldLabel>Server JSON</FieldLabel>
                          <div className="flex gap-2">
                            <button onClick={() => { setEditingServerId(null); setEditorText("") }} disabled={saving} className="action-button px-3 py-2">
                              Cancel
                            </button>
                            <button onClick={saveEditedServer} disabled={saving || !editorText.trim()} className="rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">
                              Save
                            </button>
                          </div>
                        </div>
                        <textarea
                          value={editorText}
                          onChange={(event) => setEditorText(event.target.value)}
                          rows={16}
                          spellCheck={false}
                          className="field-control mt-3 min-h-80 w-full resize-y px-3 py-2 text-xs font-mono leading-5"
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="panel p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Client JSON</h2>
              <p className="mt-1 text-xs text-[var(--foreground-dim)]">Enabled servers exported in common MCP client format.</p>
              <pre className="mt-4 max-h-96 overflow-auto rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-4 text-[11px] leading-5 text-[var(--foreground-dim)]">
                {configText}
              </pre>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
