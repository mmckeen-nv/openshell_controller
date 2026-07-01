// File-backed sandbox-access store. Replaces the SANDBOX_ACCESS_USERS env var
// for runtime mutations so an operator can grant/revoke access without
// restarting the controller.
//
// Reads:
//   1. JSON file at SANDBOX_ACCESS_FILE (default: process.cwd()/data/sandbox-access.json)
//   2. SANDBOX_ACCESS_USERS env var (CSV, legacy/dev fallback)
//
// Writes only the JSON file. The env var is left untouched for backwards
// compatibility with deployments that haven't migrated yet.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parseSandboxAccessCSV, serializeSandboxAccessEntries } from "./policy.mjs"

export type SandboxAccessEntry = { sandboxName: string; email: string }
export type SandboxAccessMap = Map<string, Set<string>>

const DEFAULT_FILE = path.join(process.cwd(), "data", "sandbox-access.json")

function getStoreFilePath(): string {
  return process.env.SANDBOX_ACCESS_FILE?.trim() || DEFAULT_FILE
}

function readFromFile(): SandboxAccessMap | null {
  const file = getStoreFilePath()
  if (!existsSync(file)) return null
  try {
    const raw = readFileSync(file, "utf8")
    const parsed = JSON.parse(raw)
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    const map: SandboxAccessMap = new Map()
    for (const entry of entries) {
      const sandboxName = typeof entry?.sandboxName === "string" ? entry.sandboxName.trim() : ""
      const email = typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : ""
      if (!sandboxName || !email) continue
      if (!map.has(sandboxName)) map.set(sandboxName, new Set<string>())
      map.get(sandboxName)!.add(email)
    }
    return map
  } catch {
    return null
  }
}

/**
 * Returns the sandbox-access map, reading fresh from disk on every call.
 * Order: file (if present and parseable) → SANDBOX_ACCESS_USERS env var → empty.
 */
export function getSandboxAccessMap(): SandboxAccessMap {
  const fromFile = readFromFile()
  if (fromFile) return fromFile
  return parseSandboxAccessCSV(process.env.SANDBOX_ACCESS_USERS || "")
}

/**
 * Lists the stored entries (file if present, else env-var fallback) as a
 * flat array, sorted for stable rendering.
 */
export function listSandboxAccessEntries(): SandboxAccessEntry[] {
  const map = getSandboxAccessMap()
  const entries: SandboxAccessEntry[] = []
  for (const [sandboxName, emails] of map.entries()) {
    for (const email of emails) entries.push({ sandboxName, email })
  }
  entries.sort((a, b) => a.sandboxName.localeCompare(b.sandboxName) || a.email.localeCompare(b.email))
  return entries
}

/**
 * Atomically replaces the stored entries with the provided set. Writes to a
 * temp file in the same directory then renames into place.
 */
export function replaceSandboxAccessEntries(entries: SandboxAccessEntry[]): { path: string; count: number } {
  const file = getStoreFilePath()
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })

  const normalized = new Map<string, Set<string>>()
  for (const entry of entries) {
    const sandboxName = typeof entry?.sandboxName === "string" ? entry.sandboxName.trim() : ""
    const email = typeof entry?.email === "string" ? entry.email.trim().toLowerCase() : ""
    if (!sandboxName || !email) continue
    if (!normalized.has(sandboxName)) normalized.set(sandboxName, new Set<string>())
    normalized.get(sandboxName)!.add(email)
  }
  const out: SandboxAccessEntry[] = []
  for (const [sandboxName, emails] of normalized.entries()) {
    for (const email of emails) out.push({ sandboxName, email })
  }
  out.sort((a, b) => a.sandboxName.localeCompare(b.sandboxName) || a.email.localeCompare(b.email))

  const payload = JSON.stringify({ entries: out, updatedAt: new Date().toISOString() }, null, 2) + "\n"
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, payload, { mode: 0o600 })
  renameSync(tmp, file)
  return { path: file, count: out.length }
}

/**
 * Migration helper: convenience CSV (kept for callers that want to display the
 * raw legacy format, e.g. for backwards-compatible debug output).
 */
export function serializeAsCSV(entries: SandboxAccessEntry[]): string {
  return serializeSandboxAccessEntries(entries)
}
