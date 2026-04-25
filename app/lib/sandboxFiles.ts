import { spawn } from "node:child_process"
import path from "node:path"
import { resolveSandboxRef } from "./openshellHost"

const HOME = process.env.HOME || ""
const OPENSHELL_BIN = process.env.OPENSHELL_BIN || `${HOME}/.local/bin/openshell`
const HOST_PATH = [
  `${HOME}/.local/bin`,
  `${HOME}/.nvm/versions/node/v22.22.2/bin`,
  `${HOME}/.nvm/versions/node/v22.22.1/bin`,
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  process.env.PATH || "",
].filter(Boolean).join(":")

export const MAX_FILE_BYTES = Number.parseInt(process.env.SANDBOX_FILE_TRANSFER_MAX_BYTES || String(128 * 1024 * 1024), 10)
export const MAX_MULTIPART_REQUEST_BYTES = MAX_FILE_BYTES + Math.min(10 * 1024 * 1024, Math.max(1024 * 1024, Math.floor(MAX_FILE_BYTES / 10)))
const ALLOWED_ROOTS = ["/sandbox", "/tmp"]
const MAX_LIST_ENTRIES = Number.parseInt(process.env.SANDBOX_FILE_LIST_MAX_ENTRIES || "200", 10)

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function sanitizeFileName(value: string) {
  const base = path.posix.basename(value.trim() || "upload.bin")
  return base.replace(/[^\w.@:+-]/g, "_") || "upload.bin"
}

function sanitizeArchiveStem(value: string) {
  return value.trim().replace(/[^\w.@:+-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "sandbox"
}

export function normalizeSandboxPath(input: string, fallbackFileName?: string) {
  const raw = input.trim()
  if (!raw) throw new Error("sandbox path is required")
  if (raw.includes("\0")) throw new Error("sandbox path contains unsupported characters")

  const absolute = raw.startsWith("/") ? raw : path.posix.join("/sandbox", raw)
  const withFileName = absolute.endsWith("/") && fallbackFileName
    ? path.posix.join(absolute, sanitizeFileName(fallbackFileName))
    : absolute
  const normalized = path.posix.normalize(withFileName)
  const allowed = ALLOWED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  if (!allowed) throw new Error("sandbox path must be under /sandbox or /tmp")
  return normalized
}

export function assertRequestContentLength(request: Request, maxBytes = MAX_MULTIPART_REQUEST_BYTES) {
  const raw = request.headers.get("content-length")
  if (!raw) return
  const size = Number.parseInt(raw, 10)
  if (Number.isFinite(size) && size > maxBytes) {
    throw new Error(`request is too large; max transfer size is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB`)
  }
}

function runSandboxExec(sandboxName: string, script: string, input?: Buffer, timeoutMs = 60000) {
  return new Promise<{ stdout: Buffer; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(OPENSHELL_BIN, ["sandbox", "exec", "-n", sandboxName, "--", "sh", "-lc", script], {
      env: {
        ...process.env,
        PATH: HOST_PATH,
        OPENSHELL_GATEWAY: process.env.OPENSHELL_GATEWAY || "nemoclaw",
        NO_COLOR: "1",
        CLICOLOR: "0",
        CLICOLOR_FORCE: "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(stdout), stderr: stderr.trim(), code })
    })

    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

export async function resolveSandboxName(sandboxId: string) {
  const resolved = await resolveSandboxRef(sandboxId)
  return resolved.name
}

export async function uploadSandboxFile(sandboxId: string, destinationPath: string, fileName: string, payload: Buffer) {
  if (payload.byteLength > MAX_FILE_BYTES) {
    throw new Error(`file is too large; max transfer size is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB`)
  }

  const sandboxName = await resolveSandboxName(sandboxId)
  const targetPath = normalizeSandboxPath(destinationPath, fileName)
  const targetDir = path.posix.dirname(targetPath)
  const script = [
    `mkdir -p ${shellQuote(targetDir)}`,
    `cat > ${shellQuote(targetPath)}`,
    `chmod 0644 ${shellQuote(targetPath)}`,
  ].join(" && ")
  const result = await runSandboxExec(sandboxName, script, payload, 120000)
  if (result.code !== 0) throw new Error(result.stderr || "failed to upload file to sandbox")

  return {
    sandboxName,
    path: targetPath,
    bytes: payload.byteLength,
  }
}

export async function downloadSandboxFile(sandboxId: string, sourcePath: string) {
  const sandboxName = await resolveSandboxName(sandboxId)
  const targetPath = normalizeSandboxPath(sourcePath)
  const statScript = `test -f ${shellQuote(targetPath)} && wc -c < ${shellQuote(targetPath)}`
  const stat = await runSandboxExec(sandboxName, statScript, undefined, 30000)
  if (stat.code !== 0) throw new Error(stat.stderr || "sandbox file does not exist or is not a regular file")
  const size = Number.parseInt(stat.stdout.toString("utf8").trim(), 10)
  if (Number.isFinite(size) && size > MAX_FILE_BYTES) {
    throw new Error(`file is too large; max transfer size is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB`)
  }

  const result = await runSandboxExec(sandboxName, `cat ${shellQuote(targetPath)}`, undefined, 120000)
  if (result.code !== 0) throw new Error(result.stderr || "failed to download file from sandbox")

  return {
    sandboxName,
    path: targetPath,
    fileName: path.posix.basename(targetPath) || "download.bin",
    bytes: result.stdout,
  }
}

export type SandboxFileListEntry = {
  name: string
  path: string
  type: "file" | "directory" | "symlink" | "other"
  size: number | null
  modifiedAt: string | null
}

function normalizeFindType(type: string): SandboxFileListEntry["type"] {
  if (type === "f") return "file"
  if (type === "d") return "directory"
  if (type === "l") return "symlink"
  return "other"
}

export async function listSandboxFiles(sandboxId: string, directoryPath: string) {
  const sandboxName = await resolveSandboxName(sandboxId)
  const targetPath = normalizeSandboxPath(directoryPath || "/sandbox")
  const script = [
    `test -d ${shellQuote(targetPath)}`,
    `find ${shellQuote(targetPath)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%p\\n' | sort -k4 | head -n ${MAX_LIST_ENTRIES}`,
  ].join(" && ")
  const result = await runSandboxExec(sandboxName, script, undefined, 30000)
  if (result.code !== 0) throw new Error(result.stderr || "sandbox directory does not exist or is not readable")

  const entries = result.stdout
    .toString("utf8")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): SandboxFileListEntry | null => {
      const [type, sizeValue, modifiedValue, ...pathParts] = line.split("\t")
      const entryPath = pathParts.join("\t")
      if (!entryPath) return null
      const modifiedSeconds = Number.parseFloat(modifiedValue)
      return {
        name: path.posix.basename(entryPath),
        path: entryPath,
        type: normalizeFindType(type),
        size: Number.isFinite(Number.parseInt(sizeValue, 10)) ? Number.parseInt(sizeValue, 10) : null,
        modifiedAt: Number.isFinite(modifiedSeconds) ? new Date(modifiedSeconds * 1000).toISOString() : null,
      }
    })
    .filter((entry): entry is SandboxFileListEntry => Boolean(entry))

  return {
    sandboxName,
    path: targetPath,
    entries,
    truncated: entries.length >= MAX_LIST_ENTRIES,
  }
}

export async function backupSandboxArchive(sandboxId: string, sourcePath: string) {
  const sandboxName = await resolveSandboxName(sandboxId)
  const targetPath = normalizeSandboxPath(sourcePath || "/sandbox")
  const timestamp = new Date().toISOString()
  const archiveName = `${sanitizeArchiveStem(sandboxName)}-${timestamp.replace(/[:.]/g, "-")}.tar.gz`
  const script = [
    `test -d ${shellQuote(targetPath)}`,
    `tar -C ${shellQuote(targetPath)} -czf - .`,
  ].join(" && ")
  const result = await runSandboxExec(sandboxName, script, undefined, 120000)
  if (result.code !== 0) throw new Error(result.stderr || "failed to create sandbox backup archive")
  if (result.stdout.byteLength > MAX_FILE_BYTES) {
    throw new Error(`backup archive is too large; max transfer size is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB`)
  }

  return {
    sandboxName,
    sourcePath: targetPath,
    fileName: archiveName,
    bytes: result.stdout,
    createdAt: timestamp,
  }
}

export async function restoreSandboxArchive(
  sandboxId: string,
  targetPathInput: string,
  archiveName: string,
  payload: Buffer,
  replace: boolean
) {
  if (payload.byteLength > MAX_FILE_BYTES) {
    throw new Error(`archive is too large; max transfer size is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB`)
  }

  const sandboxName = await resolveSandboxName(sandboxId)
  const targetPath = normalizeSandboxPath(targetPathInput || "/sandbox")
  const safeArchiveName = sanitizeFileName(archiveName || "sandbox-backup.tar.gz")
  const script = [
    `tmp_archive="$(mktemp /tmp/openshell-restore.XXXXXX.tar.gz)"`,
    `cat > "$tmp_archive"`,
    `tar -tzf "$tmp_archive" >/tmp/openshell-restore-list.$$`,
    `tar -tvzf "$tmp_archive" >/tmp/openshell-restore-verbose.$$`,
    `while IFS= read -r entry; do case "$entry" in ""|/*|../*|*/../*|*"/..") rm -f "$tmp_archive" /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 42;; esac; done < /tmp/openshell-restore-list.$$`,
    `while IFS= read -r entry; do case "$entry" in [-d]*) :;; *) rm -f "$tmp_archive" /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$; exit 43;; esac; done < /tmp/openshell-restore-verbose.$$`,
    `mkdir -p ${shellQuote(targetPath)}`,
    replace ? `find ${shellQuote(targetPath)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +` : `:`,
    `if grep -q '^payload/' /tmp/openshell-restore-list.$$; then tar -xzf "$tmp_archive" -C ${shellQuote(targetPath)} --strip-components=1 --wildcards 'payload/*'; else tar -xzf "$tmp_archive" -C ${shellQuote(targetPath)}; fi`,
    `rm -f "$tmp_archive" /tmp/openshell-restore-list.$$ /tmp/openshell-restore-verbose.$$`,
  ].join(" && ")
  const result = await runSandboxExec(sandboxName, script, payload, 120000)
  if (result.code === 42) throw new Error("archive contains unsafe paths")
  if (result.code === 43) throw new Error("archive contains unsupported entry types")
  if (result.code !== 0) throw new Error(result.stderr || "failed to restore sandbox archive")

  return {
    sandboxName,
    archiveName: safeArchiveName,
    targetPath,
    bytes: payload.byteLength,
    mode: replace ? "replace" : "merge",
  }
}
