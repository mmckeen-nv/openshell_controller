import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { isIP } from "node:net"
import { release } from "node:os"
import { promisify } from "node:util"

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
const DEFAULT_OLLAMA_PORT = "11434"
const OLLAMA_BASE_URL = normalizeOllamaBaseUrl(
  process.env.OPENSHELL_OLLAMA_BASE_URL || process.env.OLLAMA_BASE_URL || process.env.OLLAMA_HOST || DEFAULT_OLLAMA_URL,
)
const OLLAMA_PROBE_TIMEOUT_MS = parsePositiveInteger(process.env.OPENSHELL_OLLAMA_PROBE_TIMEOUT_MS, 2500)
const WINDOWS_CURL_TIMEOUT_SECONDS = Math.max(1, Math.ceil(OLLAMA_PROBE_TIMEOUT_MS / 1000))
const WINDOWS_CURL_OUTPUT_LIMIT = 10 * 1024 * 1024
const WINDOWS_LOCAL_OLLAMA_URLS = [DEFAULT_OLLAMA_URL, "http://localhost:11434"]
const execFileAsync = promisify(execFile)

export const runtime = "nodejs"

type OllamaTag = {
  name?: string
  model?: string
  modified_at?: string
  size?: number
  digest?: string
  details?: {
    family?: string
    parameter_size?: string
    quantization_level?: string
  }
}

type OllamaHostKind = "custom" | "linux" | "win" | "wsl2"

type OllamaProbeCandidate = {
  baseUrl: string
  source: string
  hostKind: OllamaHostKind
  hostLabel: string
  via: "fetch" | "windows-curl" | "windows-powershell"
}

type OllamaProbeResult = OllamaProbeCandidate & {
  ok: boolean
  data?: any
  status?: number
  error?: string
  elapsedMs: number
}

type OllamaModelRow = {
  id: string
  name: string
  model: string
  modifiedAt: string | null
  size: number | null
  sizeLabel: string | null
  digest: string | null
  family: string | null
  parameterSize: string | null
  quantization: string | null
  hostKind: OllamaHostKind
  hostLabel: string
  source: string
  baseUrl: string
  via: OllamaProbeCandidate["via"]
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(String(value || ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function ensureHttpUrl(value: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`
}

function stripOllamaEndpointSuffix(pathname = "") {
  let value = pathname.replace(/\/+$/, "")
  for (const suffix of ["/api/tags", "/v1/models", "/v1/chat/completions", "/v1/completions", "/v1"]) {
    if (value === suffix) return ""
    if (value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length)
      break
    }
  }
  return value
}

function normalizeOllamaBaseUrl(value: string | undefined) {
  const raw = String(value || "").trim()
  if (!raw) return ""

  try {
    const url = new URL(ensureHttpUrl(raw))
    if (url.protocol !== "http:" && url.protocol !== "https:") return ""
    url.search = ""
    url.hash = ""
    if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") {
      url.hostname = "127.0.0.1"
    }
    const pathname = stripOllamaEndpointSuffix(url.pathname)
    url.pathname = pathname || "/"
    return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname.replace(/\/+$/, "")}`
  } catch {
    return ""
  }
}

function tagsUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/api/tags`
}

function formatBytes(size: unknown) {
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) return null
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

function modelRowsFromTags(data: any, origin: OllamaProbeCandidate): OllamaModelRow[] {
  return Array.isArray(data?.models)
    ? data.models.map((item: OllamaTag) => {
        const name = item.model || item.name || ""
        return {
          id: `${origin.hostKind}:${name}`,
          name,
          model: name,
          modifiedAt: item.modified_at || null,
          size: typeof item.size === "number" ? item.size : null,
          sizeLabel: formatBytes(item.size),
          digest: item.digest || null,
          family: item.details?.family || null,
          parameterSize: item.details?.parameter_size || null,
          quantization: item.details?.quantization_level || null,
          hostKind: origin.hostKind,
          hostLabel: origin.hostLabel,
          source: origin.source,
          baseUrl: origin.baseUrl,
          via: origin.via,
        }
      }).filter((item: { name: string }) => item.name)
    : []
}

async function isWslRuntime() {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true
  const kernelRelease = release().toLowerCase()
  if (kernelRelease.includes("microsoft") || kernelRelease.includes("wsl")) return true
  try {
    return /microsoft|wsl/i.test(await readFile("/proc/version", "utf8"))
  } catch {
    return false
  }
}

function parseNameserverHosts(contents: string) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*nameserver\s+(\S+)/)?.[1] || "")
    .filter((host) => Boolean(host && isIP(host)))
}

function parseRouteGateway(hex: string) {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null
  const bytes = hex.match(/../g)
  if (!bytes) return null
  const host = bytes.map((byte) => Number.parseInt(byte, 16)).reverse().join(".")
  return host === "0.0.0.0" ? null : host
}

function parseDefaultRouteGateways(contents: string) {
  return contents
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns[1] === "00000000" && columns[2])
    .map((columns) => parseRouteGateway(columns[2]))
    .filter((host): host is string => Boolean(host))
}

async function readWslHostCandidates() {
  const [resolvConf, routeTable] = await Promise.all([
    readFile("/etc/resolv.conf", "utf8").catch(() => ""),
    readFile("/proc/net/route", "utf8").catch(() => ""),
  ])
  return Array.from(new Set([
    ...parseNameserverHosts(resolvConf),
    ...parseDefaultRouteGateways(routeTable),
  ]))
}

function hostUrl(host: string, port = DEFAULT_OLLAMA_PORT) {
  const formattedHost = isIP(host) === 6 && !host.startsWith("[") ? `[${host}]` : host
  return `http://${formattedHost}:${port}`
}

function addFetchCandidate(
  candidates: OllamaProbeCandidate[],
  value: string | undefined,
  source: string,
  hostKind: OllamaHostKind,
  hostLabel: string,
) {
  const baseUrl = normalizeOllamaBaseUrl(value)
  if (!baseUrl) return
  candidates.push({ baseUrl, source, hostKind, hostLabel, via: "fetch" })
}

function addWindowsInteropCandidates(
  candidates: OllamaProbeCandidate[],
  value: string | undefined,
  source: string,
) {
  if (process.env.OPENSHELL_OLLAMA_WINDOWS_INTEROP === "0") return
  const baseUrl = normalizeOllamaBaseUrl(value)
  if (!baseUrl) return
  candidates.push({ baseUrl, source, hostKind: "win", hostLabel: "WIN", via: "windows-curl" })
  candidates.push({ baseUrl, source, hostKind: "win", hostLabel: "WIN", via: "windows-powershell" })
}

function dedupeCandidates(candidates: OllamaProbeCandidate[]) {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.via}:${candidate.baseUrl}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function customHostCandidates() {
  return String(process.env.OPENSHELL_OLLAMA_HOSTS || "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean)
}

function customHostUrl(host: string) {
  if (host.includes("://")) return host
  if (isIP(host) === 6) return hostUrl(host)
  if (/^[^/]+:\d+(?:\/.*)?$/.test(host)) return host
  return hostUrl(host)
}

async function buildProbeCandidates() {
  const candidates: OllamaProbeCandidate[] = []
  const wsl = await isWslRuntime()

  addFetchCandidate(candidates, process.env.OPENSHELL_OLLAMA_BASE_URL, "OPENSHELL_OLLAMA_BASE_URL", "custom", "CUSTOM")
  addFetchCandidate(candidates, process.env.OLLAMA_BASE_URL, "OLLAMA_BASE_URL", "custom", "CUSTOM")
  addFetchCandidate(candidates, process.env.OLLAMA_HOST, "OLLAMA_HOST", "custom", "CUSTOM")
  for (const host of customHostCandidates()) {
    addFetchCandidate(candidates, customHostUrl(host), "OPENSHELL_OLLAMA_HOSTS", "custom", "CUSTOM")
  }
  addFetchCandidate(candidates, DEFAULT_OLLAMA_URL, wsl ? "wsl-localhost" : "localhost", wsl ? "wsl2" : "linux", wsl ? "WSL2" : "LINUX")

  if (wsl) {
    for (const host of await readWslHostCandidates()) {
      addFetchCandidate(candidates, hostUrl(host), "wsl-windows-host", "win", "WIN")
    }
    addFetchCandidate(candidates, hostUrl("host.docker.internal"), "host.docker.internal", "win", "WIN")
    const windowsLocalUrls = new Set([
      process.env.OPENSHELL_WINDOWS_OLLAMA_BASE_URL,
      ...WINDOWS_LOCAL_OLLAMA_URLS,
    ].filter((value): value is string => Boolean(value)))
    for (const url of windowsLocalUrls) {
      addWindowsInteropCandidates(candidates, url, "windows-localhost")
    }
  }

  return dedupeCandidates(candidates)
}

function publicProbeResult(result: OllamaProbeResult) {
  return {
    ok: result.ok,
    baseUrl: result.baseUrl,
    source: result.source,
    hostKind: result.hostKind,
    hostLabel: result.hostLabel,
    via: result.via,
    status: result.status ?? null,
    elapsedMs: result.elapsedMs,
    error: result.error || null,
  }
}

function aggregateModels(results: OllamaProbeResult[]) {
  const seen = new Set<string>()
  const models: OllamaModelRow[] = []
  for (const result of results.filter((item) => item.ok)) {
    for (const model of modelRowsFromTags(result.data, result)) {
      const key = `${model.hostKind}:${model.name}`
      if (seen.has(key)) continue
      seen.add(key)
      models.push(model)
    }
  }
  return models.sort((a, b) => {
    const sourceOrder = { wsl2: 0, win: 1, linux: 2, custom: 3 } as Record<OllamaHostKind, number>
    const sourceDiff = sourceOrder[a.hostKind] - sourceOrder[b.hostKind]
    return sourceDiff || a.name.localeCompare(b.name)
  })
}

function probeErrorMessage(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return "Ollama probe timed out"
  return error instanceof Error ? error.message : "Failed to fetch Ollama models"
}

async function probeFetchCandidate(candidate: OllamaProbeCandidate): Promise<OllamaProbeResult> {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS)

  try {
    const response = await fetch(tagsUrl(candidate.baseUrl), {
      cache: "no-store",
      signal: controller.signal,
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(data?.error || `Ollama returned HTTP ${response.status}`)
    }
    if (!data || typeof data !== "object") throw new Error("Ollama returned a non-JSON response")
    return {
      ...candidate,
      ok: true,
      data,
      status: response.status,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      ...candidate,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: probeErrorMessage(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function windowsCurlExecutable() {
  const override = String(process.env.OPENSHELL_WINDOWS_CURL_EXE || "").trim()
  if (override) return override
  if (existsSync("/mnt/c/Windows/System32/curl.exe")) return "/mnt/c/Windows/System32/curl.exe"
  return "curl.exe"
}

function windowsPowerShellExecutable() {
  const override = String(process.env.OPENSHELL_WINDOWS_POWERSHELL_EXE || "").trim()
  if (override) return override
  const windowsPowerShell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  if (existsSync(windowsPowerShell)) return windowsPowerShell
  return "powershell.exe"
}

async function findWslInteropSocket() {
  if (process.env.WSL_INTEROP && existsSync(process.env.WSL_INTEROP)) return process.env.WSL_INTEROP
  const candidates = ["/run/WSL", "/var/run/WSL"]
  for (const dir of candidates) {
    try {
      const entries = await readdir(dir)
      const sockets = entries
        .filter((entry) => /_interop$/.test(entry))
        .map((entry) => `${dir}/${entry}`)
        .filter((entry) => {
          try {
            return statSync(entry).isSocket()
          } catch {
            return false
          }
        })
        .sort()
      if (sockets.length > 0) return sockets[sockets.length - 1]
    } catch {
      // Older WSL or non-systemd WSL may not have this directory.
    }
  }
  return ""
}

async function windowsInteropExecEnv() {
  const interop = await findWslInteropSocket()
  return interop ? { ...process.env, WSL_INTEROP: interop } : process.env
}

async function probeWindowsCurlCandidate(candidate: OllamaProbeCandidate): Promise<OllamaProbeResult> {
  const startedAt = Date.now()
  try {
    const { stdout } = await execFileAsync(windowsCurlExecutable(), [
      "-fsS",
      "--max-time",
      String(WINDOWS_CURL_TIMEOUT_SECONDS),
      tagsUrl(candidate.baseUrl),
    ], {
      env: await windowsInteropExecEnv(),
      timeout: OLLAMA_PROBE_TIMEOUT_MS + 1000,
      maxBuffer: WINDOWS_CURL_OUTPUT_LIMIT,
      windowsHide: true,
    })
    const data = JSON.parse(String(stdout || "{}"))
    if (!data || typeof data !== "object") throw new Error("Ollama returned a non-JSON response")
    return {
      ...candidate,
      ok: true,
      data,
      status: 200,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      ...candidate,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: probeErrorMessage(error),
    }
  }
}

async function probeWindowsPowerShellCandidate(candidate: OllamaProbeCandidate): Promise<OllamaProbeResult> {
  const startedAt = Date.now()
  try {
    const { stdout } = await execFileAsync(windowsPowerShellExecutable(), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "$ProgressPreference = 'SilentlyContinue'; (Invoke-WebRequest -UseBasicParsing -TimeoutSec $args[0] -Uri $args[1]).Content",
      String(WINDOWS_CURL_TIMEOUT_SECONDS),
      tagsUrl(candidate.baseUrl),
    ], {
      env: await windowsInteropExecEnv(),
      timeout: OLLAMA_PROBE_TIMEOUT_MS + 1000,
      maxBuffer: WINDOWS_CURL_OUTPUT_LIMIT,
      windowsHide: true,
    })
    const data = JSON.parse(String(stdout || "{}"))
    if (!data || typeof data !== "object") throw new Error("Ollama returned a non-JSON response")
    return {
      ...candidate,
      ok: true,
      data,
      status: 200,
      elapsedMs: Date.now() - startedAt,
    }
  } catch (error) {
    return {
      ...candidate,
      ok: false,
      elapsedMs: Date.now() - startedAt,
      error: probeErrorMessage(error),
    }
  }
}

async function probeCandidate(candidate: OllamaProbeCandidate) {
  switch (candidate.via) {
    case "windows-curl":
      return probeWindowsCurlCandidate(candidate)
    case "windows-powershell":
      return probeWindowsPowerShellCandidate(candidate)
    default:
      return probeFetchCandidate(candidate)
  }
}

function unreachableMessage(wsl: boolean) {
  return wsl
    ? "Ollama is not reachable from WSL localhost, the WSL Windows host gateway, or Windows localhost via WSL interop."
    : "Ollama is not reachable from the controller host."
}

export async function GET() {
  const startedAt = Date.now()
  const [wsl, candidates] = await Promise.all([
    isWslRuntime(),
    buildProbeCandidates(),
  ])

  const results = await Promise.all(candidates.map(probeCandidate))
  const availableResults = results.filter((result) => result.ok)

  if (availableResults.length > 0) {
    const models = aggregateModels(results)
    return NextResponse.json({
      ok: true,
      available: true,
      baseUrl: availableResults[0].baseUrl,
      source: availableResults[0].source,
      via: availableResults[0].via,
      sources: availableResults.map((result) => ({
        baseUrl: result.baseUrl,
        source: result.source,
        hostKind: result.hostKind,
        hostLabel: result.hostLabel,
        via: result.via,
        count: modelRowsFromTags(result.data, result).length,
      })),
      checkedHostLabels: Array.from(new Set(results.map((result) => result.hostLabel))),
      availableHostLabels: Array.from(new Set(availableResults.map((result) => result.hostLabel))),
      models,
      count: models.length,
      elapsedMs: Date.now() - startedAt,
      probed: results.map(publicProbeResult),
    })
  }

  return NextResponse.json({
    ok: false,
    available: false,
    baseUrl: candidates[0]?.baseUrl || OLLAMA_BASE_URL,
    models: [],
    count: 0,
    elapsedMs: Date.now() - startedAt,
    error: unreachableMessage(wsl),
    checkedHostLabels: Array.from(new Set(results.map((result) => result.hostLabel))),
    availableHostLabels: [],
    probed: results.map(publicProbeResult),
  }, { status: 200 })
}
