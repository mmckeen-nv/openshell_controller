import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { installMcpServer, listMcpServers } from "@/app/lib/mcpServerStore"

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const UPLOAD_DIR = path.join(STORE_DIR, "mcp-server-uploads")
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MCP_SERVER_UPLOAD_MAX_BYTES || String(128 * 1024 * 1024), 10)
const INSTALL_TIMEOUT_MS = Number.parseInt(process.env.MCP_SERVER_DEPENDENCY_INSTALL_TIMEOUT_MS || String(5 * 60 * 1000), 10)

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

async function pathExists(candidate: string) {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

async function findFileByName(root: string, fileName: string): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".venv" || entry.name === ".git") continue
    const fullPath = path.join(root, entry.name)
    if (entry.isFile() && entry.name === fileName) return fullPath
    if (entry.isDirectory()) {
      const nested = await findFileByName(fullPath, fileName)
      if (nested) return nested
    }
  }
  return null
}

async function resolveEntryPath(root: string, entrypoint: string) {
  const direct = safeEntryPath(root, entrypoint)
  if (await pathExists(direct)) return direct
  const discovered = await findFileByName(root, path.basename(entrypoint))
  if (discovered) return discovered
  throw new Error(`entrypoint was not found in uploaded server: ${entrypoint}`)
}

async function runInstallCommand(command: string, args: string[], cwd: string) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout: INSTALL_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${path.join(cwd, ".venv/bin")}:${process.env.PATH || ""}`,
      },
    })
    return [String(stdout).trim(), String(stderr).trim()].filter(Boolean).join("\n")
  } catch (error: any) {
    const detail = [String(error?.stdout || "").trim(), String(error?.stderr || "").trim(), error instanceof Error ? error.message : ""]
      .filter(Boolean)
      .join("\n")
    throw new Error(detail || `dependency install command failed: ${command} ${args.join(" ")}`)
  }
}

async function isPythonUpload(runtime: string, entrypointPath: string, root: string) {
  return /(^|\/)python(?:3(?:\.\d+)?)?$/i.test(runtime)
    || /\.py$/i.test(entrypointPath)
    || await pathExists(path.join(root, "requirements.txt"))
    || await pathExists(path.join(root, "pyproject.toml"))
}

async function isNodeUpload(runtime: string, entrypointPath: string, root: string) {
  return /(^|\/)(node|npm|npx)$/i.test(runtime)
    || /\.(mjs|cjs|js)$/i.test(entrypointPath)
    || await pathExists(path.join(root, "package.json"))
}

async function bootstrapPython(root: string, runtime: string) {
  const logs: string[] = []
  const venvDir = path.join(root, ".venv")
  const venvPython = path.join(venvDir, "bin/python")
  if (!await pathExists(venvPython)) {
    logs.push(await runInstallCommand(runtime || "python3", ["-m", "venv", venvDir], root))
  }
  const pip = path.join(venvDir, "bin/pip")
  logs.push(await runInstallCommand(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], root))
  if (await pathExists(path.join(root, "requirements.txt"))) {
    logs.push(await runInstallCommand(pip, ["install", "-r", "requirements.txt"], root))
  }
  if (await pathExists(path.join(root, "pyproject.toml"))) {
    logs.push(await runInstallCommand(pip, ["install", "-e", "."], root))
  }
  return {
    command: venvPython,
    logs: logs.filter(Boolean),
  }
}

async function bootstrapNode(root: string, runtime: string) {
  const logs: string[] = []
  if (await pathExists(path.join(root, "package.json"))) {
    const hasLock = await pathExists(path.join(root, "package-lock.json"))
    logs.push(await runInstallCommand("npm", [hasLock ? "ci" : "install"], root))
  }
  return {
    command: /(^|\/)npm$/i.test(runtime) ? runtime : "node",
    logs: logs.filter(Boolean),
  }
}

async function bootstrapUploadedServer(root: string, runtime: string, entrypointPath: string) {
  if (await isPythonUpload(runtime, entrypointPath, root)) {
    const result = await bootstrapPython(root, runtime || "python3")
    return { command: result.command, logs: result.logs, kind: "python" }
  }
  if (await isNodeUpload(runtime, entrypointPath, root)) {
    const result = await bootstrapNode(root, runtime || "node")
    return { command: result.command, logs: result.logs, kind: "node" }
  }
  return { command: runtime, logs: [] as string[], kind: "generic" }
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

    const entrypointPath = await resolveEntryPath(root, entrypoint)
    const bootstrap = await bootstrapUploadedServer(root, runtime, entrypointPath)
    const server = await installMcpServer({
      id,
      name,
      summary,
      transport: "stdio",
      command: bootstrap.command,
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
      dependencyInstall: {
        kind: bootstrap.kind,
        logs: bootstrap.logs,
      },
      ...(await listMcpServers()),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload MCP server"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
