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
  const [uploadEntrypoint, setUploadEntrypoint] = useState("server.py")
  const [editingServerId, setEditingServerId] = useState<string | null>(null)
  const [editorText, setEditorText] = useState("")
  const [registrySearch, setRegistrySearch] = useState("github")
  const [registryResults, setRegistryResults] = useState<McpCatalogEntry[]>([])
  const [registryLoading, setRegistryLoading] = useState(false)
  const [registryPage, setRegistryPage] = useState(1)
  const [lastRegistrySearch, setLastRegistrySearch] = useState("")
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)

  const installedIds = useMemo(() => new Set(servers.map((server) => server.id)), [servers])
  const enabledCount = servers.filter((server) => server.enabled).length
  const configText = JSON.stringify(config, null, 2)
  const registryPageCount = Math.max(1, Math.ceil(registryResults.length / REGISTRY_PAGE_SIZE))
  const pagedRegistryResults = registryResults.slice(
    (registryPage - 1) * REGISTRY_PAGE_SIZE,
    registryPage * REGISTRY_PAGE_SIZE,
  )

  async function load() {
    try {
      setLoading(true)
      const response = await fetch("/api/mcp", { cache: "no-store" })
      const data = await response.json() as McpResponse
      if (!response.ok) throw new Error(data.error || "Failed to load MCP configuration")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : [])
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      setMessage("")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load MCP configuration")
    } finally {
      setLoading(false)
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
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to update MCP configuration")
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
    return postUpdate({
      action: "update-access",
      serverId: server.id,
      accessMode: "allow_only",
      allowedSandboxIds: Array.from(current),
    }, `${server.name} sandbox access updated.`)
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
      form.set("entrypoint", uploadEntrypoint)
      form.set("args", customArgs)
      form.set("env", customEnv)
      if (uploadArchive) {
        form.set("archive", uploadArchive)
      } else {
        uploadFiles.forEach((file, index) => {
          form.append("files", file)
          form.append("paths", uploadPaths[index] || file.name)
        })
      }
      const response = await fetch("/api/mcp/upload", { method: "POST", body: form })
      const data = await response.json() as McpResponse
      if (!response.ok) throw new Error(data.error || "Failed to upload MCP server")
      setCatalog(Array.isArray(data.catalog) ? data.catalog : catalog)
      setServers(Array.isArray(data.servers) ? data.servers : [])
      setConfig(data.config || { mcpServers: {} })
      setUploadFiles([])
      setUploadPaths([])
      setUploadArchive(null)
      setMessage(`${customName} uploaded.`)
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
    try {
      setRegistryLoading(true)
      setRegistryResults([])
      setRegistryPage(1)
      setLastRegistrySearch(query)
      const params = new URLSearchParams({ search: query, limit: "24" })
      const response = await fetch(`/api/mcp/registry?${params}`, { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to search MCP registry")
      const results = Array.isArray(data.results) ? data.results : []
      setRegistryResults(results)
      setMessage(results.length > 0 ? `Found ${results.length} registry server${results.length === 1 ? "" : "s"}.` : "No registry servers matched that search.")
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
              <div className="border-b border-[var(--border-subtle)] pb-4">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">MCP Security</h2>
                <p className="mt-1 text-xs text-[var(--foreground-dim)]">Control which installed MCP servers are available to sandboxes.</p>
              </div>
              <div className="mt-5 space-y-4">
                {servers.length === 0 ? (
                  <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-xs text-[var(--foreground-dim)]">
                    Install an MCP server before configuring sandbox access.
                  </div>
                ) : servers.map((server) => (
                  <div key={server.id} className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                    <div className="flex items-start justify-between gap-4 max-lg:flex-col">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 className="truncate text-sm font-mono font-semibold text-[var(--foreground)]">{server.name}</h3>
                          <span className={`status-chip px-2 py-1 ${server.enabled ? "bg-[var(--status-running-bg)] text-[var(--status-running)]" : "bg-[var(--status-pending-bg)] text-[var(--status-pending)]"}`}>
                            {server.enabled ? "enabled" : "disabled"}
                          </span>
                        </div>
                        <p className="mt-2 break-all font-mono text-[11px] text-[var(--foreground-dim)]">{server.command} {server.args.join(" ")}</p>
                      </div>
                      <div className="flex shrink-0 gap-2 max-sm:w-full max-sm:[&>button]:flex-1">
                        <button
                          onClick={() => postUpdate({ action: "update-access", serverId: server.id, enabled: true }, `${server.name} enabled.`)}
                          disabled={saving || server.enabled}
                          className="action-button px-3 py-2"
                        >
                          Enable
                        </button>
                        <button
                          onClick={() => postUpdate({ action: "update-access", serverId: server.id, enabled: false }, `${server.name} disabled.`)}
                          disabled={saving || !server.enabled}
                          className="action-button px-3 py-2"
                        >
                          Disable
                        </button>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
                      <div className="space-y-2">
                        <FieldLabel>Availability</FieldLabel>
                        <select
                          value={server.accessMode}
                          onChange={(event) => postUpdate({
                            action: "update-access",
                            serverId: server.id,
                            accessMode: event.target.value,
                          }, `${server.name} availability updated.`)}
                          disabled={saving}
                          className="field-control w-full px-3 py-2 text-xs font-mono uppercase tracking-wider"
                        >
                          <option value="disabled">Disabled</option>
                          <option value="allow_all">Allow All</option>
                          <option value="allow_only">Allow Only</option>
                        </select>
                      </div>
                      <div className={server.accessMode === "allow_only" ? "space-y-2" : "opacity-50"}>
                        <FieldLabel>Allowed Sandboxes</FieldLabel>
                        {sandboxes.length === 0 ? (
                          <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-xs text-[var(--foreground-dim)]">
                            No sandboxes detected.
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                            {sandboxes.map((sandbox) => (
                              <label key={sandbox.id} className="flex items-center justify-between gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-xs">
                                <span className="min-w-0">
                                  <span className="block truncate font-mono text-[var(--foreground)]">{sandbox.name}</span>
                                  <span className="mt-1 block truncate text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{sandbox.status}</span>
                                </span>
                                <input
                                  type="checkbox"
                                  checked={sandboxAllowed(server, sandbox)}
                                  disabled={saving || server.accessMode !== "allow_only"}
                                  onChange={(event) => toggleServerSandbox(server, sandbox, event.target.checked)}
                                  className="h-4 w-4 accent-[var(--nvidia-green)]"
                                />
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel p-6">
              <div className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] pb-4 max-md:flex-col">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Registry Search</h2>
                  <p className="mt-1 text-xs text-[var(--foreground-dim)]">Search the Official MCP Registry and install compatible stdio or remote HTTP servers.</p>
                </div>
                <a href="https://registry.modelcontextprotocol.io/" target="_blank" rel="noreferrer" className="action-button px-3 py-2">
                  Open Registry
                </a>
              </div>
              <div className="mt-5 flex gap-3 max-sm:flex-col">
                <input
                  value={registrySearch}
                  onChange={(event) => setRegistrySearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") searchRegistry()
                  }}
                  placeholder="Search GitHub, Slack, filesystem, Postgres..."
                  className="field-control min-w-0 flex-1 px-3 py-2 text-sm"
                />
                <button onClick={searchRegistry} disabled={registryLoading || saving} className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">
                  {registryLoading ? "Searching..." : "Search"}
                </button>
              </div>
              {registryResults.length > 0 && (
                <>
                  <div className="mt-5 flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] pt-4 max-sm:flex-col max-sm:items-start">
                    <p className="text-xs text-[var(--foreground-dim)]">
                      Showing {((registryPage - 1) * REGISTRY_PAGE_SIZE) + 1}-{Math.min(registryPage * REGISTRY_PAGE_SIZE, registryResults.length)} of {registryResults.length}
                      {lastRegistrySearch ? ` for "${lastRegistrySearch}"` : ""}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setRegistryPage((page) => Math.max(1, page - 1))}
                        disabled={registryPage === 1}
                        className="action-button px-3 py-2"
                      >
                        Prev
                      </button>
                      <span className="min-w-16 text-center text-xs font-mono text-[var(--foreground-dim)]">
                        {registryPage} / {registryPageCount}
                      </span>
                      <button
                        onClick={() => setRegistryPage((page) => Math.min(registryPageCount, page + 1))}
                        disabled={registryPage === registryPageCount}
                        className="action-button px-3 py-2"
                      >
                        Next
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
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
                            <button
                              onClick={() => postUpdate({ action: "install", ...entry, source: "registry" }, installed ? `${entry.name} refreshed from registry.` : `${entry.name} installed from registry.`)}
                              disabled={saving}
                              className={installed ? "action-button px-3 py-2" : "rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"}
                            >
                              {installed ? "Refresh" : "Install"}
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>

            <div className="panel p-6">
              <button
                type="button"
                onClick={() => setCatalogOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nvidia-green)]"
                aria-expanded={catalogOpen}
              >
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Preconfigured Servers</h2>
                  <p className="mt-1 text-xs text-[var(--foreground-dim)]">Presets install as MCP command definitions; clients start them when needed.</p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-sm text-[var(--foreground)]">
                  {catalogOpen ? "-" : "+"}
                </span>
              </button>
              {catalogOpen && (
                <div className="mt-5 grid grid-cols-1 gap-3 border-t border-[var(--border-subtle)] pt-5 md:grid-cols-2">
                  {catalog.map((entry) => {
                    const installed = installedIds.has(entry.id)
                    return (
                      <div key={entry.id} className="metric flex min-h-44 flex-col p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">{entry.name}</h3>
                            <p className="mt-2 text-xs leading-5 text-[var(--foreground-dim)]">{entry.summary}</p>
                            {entry.websiteUrl && (
                              <a href={entry.websiteUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-[11px] font-mono uppercase tracking-wider text-[var(--nvidia-green)] hover:underline">
                                Setup Guide
                              </a>
                            )}
                          </div>
                          <span className="status-chip bg-[var(--status-pending-bg)] px-2 py-1 text-[var(--status-pending)]">{entry.transport}</span>
                        </div>
                        <div className="mt-3 min-w-0 rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-2 font-mono text-[11px] text-[var(--foreground-dim)]">
                          <span className="text-[var(--foreground)]">{entry.command}</span> {entry.args.join(" ")}
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                          <p className="truncate text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{entry.tags.join(" / ")}</p>
                          <button
                            onClick={() => postUpdate({ action: "install", id: entry.id }, installed ? `${entry.name} refreshed.` : `${entry.name} installed.`)}
                            disabled={saving}
                            className={installed ? "action-button px-3 py-2" : "rounded-sm bg-[var(--nvidia-green)] px-3 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50"}
                          >
                            {installed ? "Refresh" : "Install"}
                          </button>
                        </div>
                      </div>
                    )
                  })}
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
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Custom Server</h2>
                  <p className="mt-1 text-xs text-[var(--foreground-dim)]">Add a server command that is not in the catalog.</p>
                </div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] text-sm text-[var(--foreground)]">
                  {customOpen ? "-" : "+"}
                </span>
              </button>
              {customOpen && (
                <div className="mt-5 border-t border-[var(--border-subtle)] pt-5">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <FieldLabel>Name</FieldLabel>
                      <input value={customName} onChange={(event) => setCustomName(event.target.value)} className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Transport</FieldLabel>
                      <select value={customTransport} onChange={(event) => setCustomTransport(event.target.value as McpTransport)} className="field-control w-full px-3 py-2 text-sm font-mono">
                        <option value="stdio">stdio</option>
                        <option value="http">http</option>
                      </select>
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <FieldLabel>Summary</FieldLabel>
                      <input value={customSummary} onChange={(event) => setCustomSummary(event.target.value)} className="field-control w-full px-3 py-2 text-sm" />
                    </div>
                    <div className="space-y-2 md:col-span-2">
                      <FieldLabel>{customTransport === "http" ? "URL" : "Command"}</FieldLabel>
                      <input value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} placeholder={customTransport === "http" ? "https://mcp.example.com/mcp" : "npx, uvx, node, python"} className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Args</FieldLabel>
                      <textarea value={customArgs} onChange={(event) => setCustomArgs(event.target.value)} rows={6} className="field-control w-full resize-y px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>{customTransport === "http" ? "Headers" : "Env"}</FieldLabel>
                      <textarea value={customEnv} onChange={(event) => setCustomEnv(event.target.value)} rows={6} placeholder={customTransport === "http" ? "Authorization=Bearer token" : "API_KEY=value\nBASE_URL=http://localhost:3000"} className="field-control w-full resize-y px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Upload Runtime</FieldLabel>
                      <input value={uploadRuntime} onChange={(event) => setUploadRuntime(event.target.value)} placeholder="python3, node, uv, uvx" className="field-control w-full px-3 py-2 text-sm font-mono" />
                    </div>
                    <div className="space-y-2">
                      <FieldLabel>Upload Entrypoint</FieldLabel>
                      <input value={uploadEntrypoint} onChange={(event) => setUploadEntrypoint(event.target.value)} placeholder="server.py, src/server.py, index.js" className="field-control w-full px-3 py-2 text-sm font-mono" />
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
                      Install Custom Server
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
                      <button onClick={() => postUpdate({ action: server.enabled ? "disable" : "enable", serverId: server.id }, `${server.name} ${server.enabled ? "disabled" : "enabled"}.`)} disabled={saving} className="action-button flex-1 px-3 py-2">
                        {server.enabled ? "Disable" : "Enable"}
                      </button>
                      <button onClick={() => postUpdate({ action: "uninstall", serverId: server.id }, `${server.name} removed.`)} disabled={saving} className="action-button flex-1 px-3 py-2">
                        Remove
                      </button>
                    </div>
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
