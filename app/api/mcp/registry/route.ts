import { NextResponse } from "next/server"
import type { McpCatalogEntry } from "@/app/lib/mcpServerStore"

const REGISTRY_BASE_URL = process.env.MCP_REGISTRY_BASE_URL || "https://registry.modelcontextprotocol.io"

type RegistryArgument = {
  value?: string
  default?: string
  name?: string
}

type RegistryKeyValue = {
  name?: string
  value?: string
  default?: string
  placeholder?: string
}

type RegistryPackage = {
  registryType?: string
  identifier?: string
  version?: string
  runtimeHint?: string
  runtimeArguments?: RegistryArgument[]
  packageArguments?: RegistryArgument[]
  environmentVariables?: RegistryKeyValue[]
}

type RegistryRemote = {
  type?: string
  url?: string
  headers?: RegistryKeyValue[]
}

type RegistryServer = {
  name?: string
  title?: string
  description?: string
  version?: string
  repository?: {
    url?: string
    source?: string
  }
  packages?: RegistryPackage[]
  remotes?: RegistryRemote[]
}

type RegistryEntry = {
  server?: RegistryServer
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}

function argumentValues(args?: RegistryArgument[] | null) {
  return (args || [])
    .map((arg) => arg.value || arg.default || "")
    .filter(Boolean)
}

function keyValueMap(values?: RegistryKeyValue[] | null) {
  return Object.fromEntries(
    (values || [])
      .map((item) => [item.name || "", item.value || item.default || item.placeholder || ""])
      .filter(([name]) => Boolean(name)),
  )
}

function packageInstall(server: RegistryServer, pkg: RegistryPackage): McpCatalogEntry | null {
  if (!pkg.identifier) return null

  const runtime = pkg.runtimeHint?.trim()
  const registryType = pkg.registryType?.toLowerCase()
  const command = runtime || (registryType === "pypi" ? "uvx" : registryType === "npm" ? "npx" : "")
  if (!command) return null

  const args = [
    ...argumentValues(pkg.runtimeArguments),
    ...(command === "npx" ? ["-y"] : []),
    pkg.identifier,
    ...argumentValues(pkg.packageArguments),
  ]

  return {
    id: slugify(server.name || pkg.identifier),
    name: server.title || server.name || pkg.identifier,
    summary: server.description || `Install ${pkg.identifier} from the MCP registry.`,
    transport: "stdio",
    command,
    args,
    env: keyValueMap(pkg.environmentVariables),
    tags: ["registry", registryType || "package", server.version || ""].filter(Boolean),
  }
}

function remoteInstall(server: RegistryServer, remote: RegistryRemote): McpCatalogEntry | null {
  if (!remote.url) return null
  return {
    id: slugify(server.name || remote.url),
    name: server.title || server.name || remote.url,
    summary: server.description || `Connect to ${remote.url}.`,
    transport: "http",
    command: remote.url,
    args: [],
    env: keyValueMap(remote.headers),
    tags: ["registry", remote.type || "remote", server.version || ""].filter(Boolean),
  }
}

function normalizeRegistryEntry(entry: RegistryEntry): McpCatalogEntry | null {
  const server = entry.server
  if (!server) return null
  const packageCandidate = server.packages?.map((pkg) => packageInstall(server, pkg)).find(Boolean)
  if (packageCandidate) return packageCandidate
  return server.remotes?.map((remote) => remoteInstall(server, remote)).find(Boolean) || null
}

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url)
    const search = requestUrl.searchParams.get("search") || requestUrl.searchParams.get("q") || ""
    const limit = Math.max(1, Math.min(Number.parseInt(requestUrl.searchParams.get("limit") || "12", 10) || 12, 30))
    const registryUrl = new URL("/v0/servers", REGISTRY_BASE_URL)
    registryUrl.searchParams.set("limit", String(limit))
    registryUrl.searchParams.set("is_latest", "true")
    if (search.trim()) registryUrl.searchParams.set("search", search.trim())

    const response = await fetch(registryUrl, {
      headers: { Accept: "application/json" },
      next: { revalidate: 60 },
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.detail || data?.error || "MCP registry request failed")

    const results = Array.isArray(data?.servers)
      ? data.servers.map(normalizeRegistryEntry).filter(Boolean)
      : []

    return NextResponse.json({
      registryUrl: registryUrl.toString(),
      results,
      metadata: data?.metadata || null,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to search MCP registry"
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
