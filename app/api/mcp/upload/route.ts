import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { installMcpServer, listMcpServers } from "@/app/lib/mcpServerStore"

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const UPLOAD_DIR = path.join(STORE_DIR, "mcp-server-uploads")
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MCP_SERVER_UPLOAD_MAX_BYTES || String(128 * 1024 * 1024), 10)

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "uploaded-server"
}

function parseLines(value: unknown) {
  return typeof value === "string"
    ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : []
}

function parseEnv(value: unknown) {
  if (typeof value !== "string") return {}
  return Object.fromEntries(
    parseLines(value)
      .map((line) => {
        const [key, ...rest] = line.split("=")
        return [key?.trim() || "", rest.join("=").trim()]
      })
      .filter(([key]) => Boolean(key)),
  )
}

function normalizeRelativePath(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "")
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("uploaded file path must stay inside the server directory")
  }
  return normalized
}

function safeEntryPath(root: string, entrypoint: string) {
  const fullPath = path.resolve(root, normalizeRelativePath(entrypoint))
  if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("entrypoint must stay inside the uploaded server directory")
  }
  return fullPath
}

async function writeDirectoryUpload(form: FormData, root: string) {
  const files = form.getAll("files")
  const paths = form.getAll("paths").map((item) => String(item || ""))
  if (files.length === 0) return false
  if (files.length !== paths.length) throw new Error("directory upload paths are incomplete")

  let totalBytes = 0
  for (const [index, item] of files.entries()) {
    if (!(item instanceof File)) throw new Error("directory upload contains a non-file entry")
    const relativePath = normalizeRelativePath(paths[index] || item.name)
    const bytes = Buffer.from(await item.arrayBuffer())
    totalBytes += bytes.length
    if (totalBytes > MAX_UPLOAD_BYTES) throw new Error("uploaded MCP server is too large")
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, bytes, { mode: 0o600 })
  }
  return true
}

async function writeArchiveUpload(form: FormData, root: string) {
  const archive = form.get("archive")
  if (!(archive instanceof File)) return false
  const bytes = Buffer.from(await archive.arrayBuffer())
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error("uploaded MCP server archive is too large")

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcp-server-upload-"))
  const archivePath = path.join(tempDir, archive.name || "server-upload")
  await writeFile(archivePath, bytes, { mode: 0o600 })
  try {
    if (/\.zip$/i.test(archivePath)) {
      await execFileAsync("unzip", ["-q", archivePath, "-d", root], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
      return true
    }
    if (/\.(tgz|tar\.gz)$/i.test(archivePath)) {
      await execFileAsync("tar", ["-xzf", archivePath, "-C", root], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
      return true
    }
    if (/\.tar$/i.test(archivePath)) {
      await execFileAsync("tar", ["-xf", archivePath, "-C", root], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 })
      return true
    }
    throw new Error("upload archive must be .zip, .tgz, .tar.gz, or .tar")
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const name = String(form.get("name") || "uploaded-server").trim()
    const id = slugify(String(form.get("id") || name))
    const summary = String(form.get("summary") || "Uploaded MCP server").trim()
    const runtime = String(form.get("runtime") || "python3").trim()
    const entrypoint = String(form.get("entrypoint") || "server.py").trim()
    const root = path.join(UPLOAD_DIR, id)

    if (!runtime) throw new Error("runtime command is required")
    if (!entrypoint) throw new Error("entrypoint is required")

    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true, mode: 0o700 })

    const uploadedDirectory = await writeDirectoryUpload(form, root)
    const uploadedArchive = uploadedDirectory ? false : await writeArchiveUpload(form, root)
    if (!uploadedDirectory && !uploadedArchive) throw new Error("choose a directory, .zip, .tgz, .tar.gz, or .tar server upload")

    const entrypointPath = safeEntryPath(root, entrypoint)
    const server = await installMcpServer({
      id,
      name,
      summary,
      transport: "stdio",
      command: runtime,
      args: [entrypointPath, ...parseLines(form.get("args"))],
      env: parseEnv(form.get("env")),
      tags: ["uploaded", "custom"],
      source: "custom",
      enabled: true,
    })

    return NextResponse.json({
      ok: true,
      server,
      uploadRoot: root,
      ...(await listMcpServers()),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload MCP server"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
