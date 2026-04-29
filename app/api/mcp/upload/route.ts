import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { preflightMcpServer } from "@/app/lib/mcpPreflight"
import { repairUploadedMcpServerWithLlm, type McpPreflightRepairResult } from "@/app/lib/mcpPreflightRepair"
import { installMcpServer, listMcpServers, type McpServerInstall } from "@/app/lib/mcpServerStore"

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || "/tmp"
const STORE_DIR = process.env.NEMOCLAW_DASHBOARD_STATE_DIR || path.join(HOME, ".nemoclaw-dashboard")
const UPLOAD_DIR = path.join(STORE_DIR, "mcp-server-uploads")
const MAX_UPLOAD_BYTES = Number.parseInt(process.env.MCP_SERVER_UPLOAD_MAX_BYTES || String(128 * 1024 * 1024), 10)
const INSTALL_TIMEOUT_MS = Number.parseInt(process.env.MCP_SERVER_DEPENDENCY_INSTALL_TIMEOUT_MS || String(5 * 60 * 1000), 10)
const ENTRY_MODES = new Set(["file", "python-module", "console-script"])
const UPLOAD_MODES = new Set(["stage", "preflight", "install-staged"])

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

function normalizeEntryMode(value: unknown) {
  const mode = String(value || "file").trim()
  return ENTRY_MODES.has(mode) ? mode : "file"
}

function normalizeUploadMode(value: unknown) {
  const mode = String(value || "").trim()
  return UPLOAD_MODES.has(mode) ? mode : ""
}

function normalizeRelativePath(value: string) {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "")
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("uploaded file path must stay inside the server directory")
  }
  return normalized
}

function validatePythonModule(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value)) {
    throw new Error("python module entrypoint must look like package.module")
  }
}

function validateConsoleScript(value: string) {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("console script entrypoint must be a script name, not a path")
  }
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

async function ensureUploadRoot(id: string) {
  const root = path.resolve(UPLOAD_DIR, id)
  const uploadRoot = path.resolve(UPLOAD_DIR)
  if (root !== uploadRoot && !root.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error("staged upload id must stay inside the MCP upload directory")
  }
  if (!await pathExists(root)) throw new Error("staged MCP server upload was not found")
  return root
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

async function hasProjectManifest(candidate: string) {
  return await pathExists(path.join(candidate, "pyproject.toml"))
    || await pathExists(path.join(candidate, "requirements.txt"))
    || await pathExists(path.join(candidate, "package.json"))
}

async function findSingleNestedProjectRoot(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const visible = entries.filter((entry) => !entry.name.startsWith("."))
  if (visible.length !== 1 || !visible[0]?.isDirectory()) return null
  const nested = path.join(root, visible[0].name)
  return await hasProjectManifest(nested) ? nested : null
}

async function resolveProjectRoot(root: string, entrypointPath: string | null) {
  if (await hasProjectManifest(root)) return root
  if (entrypointPath) {
    let candidate = path.dirname(entrypointPath)
    while (candidate.startsWith(root)) {
      if (await hasProjectManifest(candidate)) return candidate
      const parent = path.dirname(candidate)
      if (parent === candidate) break
      candidate = parent
    }
  }
  return await findSingleNestedProjectRoot(root) || root
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

async function bootstrapUploadedServer(root: string, runtime: string, entrypoint: string) {
  if (await isPythonUpload(runtime, entrypoint, root)) {
    const result = await bootstrapPython(root, runtime || "python3")
    return { command: result.command, logs: result.logs, kind: "python" }
  }
  if (await isNodeUpload(runtime, entrypoint, root)) {
    const result = await bootstrapNode(root, runtime || "node")
    return { command: result.command, logs: result.logs, kind: "node" }
  }
  return { command: runtime, logs: [] as string[], kind: "generic" }
}

async function launchCommandForUpload(
  projectRoot: string,
  bootstrap: Awaited<ReturnType<typeof bootstrapUploadedServer>>,
  entryMode: string,
  entrypoint: string,
  entrypointPath: string | null,
  extraArgs: string[],
) {
  if (entryMode === "python-module") {
    validatePythonModule(entrypoint)
    if (bootstrap.kind !== "python") throw new Error("python module entrypoint requires a Python upload")
    return { command: bootstrap.command, args: ["-m", entrypoint, ...extraArgs] }
  }
  if (entryMode === "console-script") {
    validateConsoleScript(entrypoint)
    if (bootstrap.kind === "python") {
      const scriptPath = path.join(projectRoot, ".venv/bin", entrypoint)
      if (!await pathExists(scriptPath)) throw new Error(`console script was not installed in the upload virtualenv: ${entrypoint}`)
      return { command: scriptPath, args: extraArgs }
    }
    return { command: entrypoint, args: extraArgs }
  }
  if (!entrypointPath) throw new Error("file entrypoint was not resolved")
  return { command: bootstrap.command, args: [entrypointPath, ...extraArgs] }
}

async function buildUploadCandidate({
  root,
  id,
  name,
  summary,
  runtime,
  entryMode,
  entrypoint,
  args,
  env,
}: {
  root: string
  id: string
  name: string
  summary: string
  runtime: string
  entryMode: string
  entrypoint: string
  args: string[]
  env: Record<string, string>
}) {
  const entrypointPath = entryMode === "file" ? await resolveEntryPath(root, entrypoint) : null
  const projectRoot = await resolveProjectRoot(root, entrypointPath)
  const bootstrap = await bootstrapUploadedServer(projectRoot, runtime, entrypoint)
  const launch = await launchCommandForUpload(projectRoot, bootstrap, entryMode, entrypoint, entrypointPath, args)
  const candidate = {
    id,
    name,
    summary,
    transport: "stdio",
    command: launch.command,
    args: launch.args,
    env,
    tags: ["uploaded", "custom"],
    source: "custom",
    enabled: true,
  } satisfies {
    id: string
    name: string
    summary: string
    transport: "stdio"
    command: string
    args: string[]
    env: Record<string, string>
    tags: string[]
    source: "custom"
    enabled: boolean
  }
  return { candidate, projectRoot, bootstrap }
}

function installCandidateFrom(candidate: Awaited<ReturnType<typeof buildUploadCandidate>>["candidate"]): McpServerInstall {
  return {
    ...candidate,
    installedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accessMode: "disabled",
    allowedSandboxIds: [],
  }
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
    const mode = normalizeUploadMode(form.get("mode"))
    const name = String(form.get("name") || "uploaded-server").trim()
    const id = slugify(String(form.get("id") || name))
    const summary = String(form.get("summary") || "Uploaded MCP server").trim()
    const runtime = String(form.get("runtime") || "python3").trim()
    const entrypoint = String(form.get("entrypoint") || "server.py").trim()
    const entryMode = normalizeEntryMode(form.get("entryMode"))
    const sandboxId = String(form.get("sandboxId") || "").trim()
    const repairEnabled = String(form.get("repair") || "true") !== "false"
    const root = path.join(UPLOAD_DIR, id)

    if (!runtime) throw new Error("runtime command is required")
    if (!entrypoint) throw new Error("entrypoint is required")

    if (mode === "preflight" || mode === "install-staged") {
      const root = await ensureUploadRoot(id)
      const { candidate: initialCandidate, projectRoot, bootstrap } = await buildUploadCandidate({
        root,
        id,
        name,
        summary,
        runtime,
        entryMode,
        entrypoint,
        args: parseLines(form.get("args")),
        env: parseEnv(form.get("env")),
      })
      let candidate = initialCandidate

      if (mode === "preflight") {
        let preflight = await preflightMcpServer(installCandidateFrom(candidate))
        let repair: McpPreflightRepairResult | null = null

        if (!preflight.ok && repairEnabled) {
          try {
            repair = await repairUploadedMcpServerWithLlm({
              uploadRoot: root,
              projectRoot,
              server: installCandidateFrom(candidate),
              preflight,
              dependencyLogs: bootstrap.logs,
              sandboxId: sandboxId || null,
            })
            if (repair.updatedServer) {
              candidate = {
                ...candidate,
                command: repair.updatedServer.command,
                args: repair.updatedServer.args,
                env: repair.updatedServer.env,
              }
            }
            if (repair.ok) {
              preflight = await preflightMcpServer(installCandidateFrom(candidate))
            }
          } catch (error) {
            repair = {
              attempted: true,
              ok: false,
              provider: "openai-compatible",
              model: "",
              baseUrl: process.env.MCP_PREFLIGHT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.VLLM_BASE_URL || "",
              summary: "LLM-assisted repair could not complete.",
              changes: [],
              error: error instanceof Error ? error.message : "MCP repair failed",
            }
          }
        }

        return NextResponse.json({
          ok: true,
          stagedUpload: {
            id,
            name,
            summary,
            runtime,
            entryMode,
            entrypoint,
            uploadRoot: root,
            projectRoot,
          },
          candidate,
          dependencyInstall: {
            kind: bootstrap.kind,
            logs: bootstrap.logs,
          },
          preflight,
          repair,
        })
      }

      const command = String(form.get("command") || candidate.command).trim()
      const commandArgs = parseLines(form.get("commandArgs"))
      const suppliedArgs = commandArgs.length > 0 ? commandArgs : candidate.args
      const installEnvText = String(form.get("installEnv") || "")
      const suppliedEnv = installEnvText ? parseEnv(installEnvText) : candidate.env
      const preflightOk = String(form.get("preflightOk") || "true") !== "false"
      const server = await installMcpServer({
        ...candidate,
        command: command || candidate.command,
        args: suppliedArgs,
        env: suppliedEnv,
        enabled: preflightOk,
        tags: preflightOk ? candidate.tags : [...candidate.tags, "preflight-failed"],
      })

      return NextResponse.json({
        ok: true,
        server,
        uploadRoot: root,
        projectRoot,
        dependencyInstall: {
          kind: bootstrap.kind,
          logs: bootstrap.logs,
        },
        ...(await listMcpServers()),
      })
    }

    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true, mode: 0o700 })

    const uploadedDirectory = await writeDirectoryUpload(form, root)
    const uploadedArchive = uploadedDirectory ? false : await writeArchiveUpload(form, root)
    if (!uploadedDirectory && !uploadedArchive) throw new Error("choose a directory, .zip, .tgz, .tar.gz, or .tar server upload")

    if (mode === "stage") {
      const entrypointPath = entryMode === "file" ? await resolveEntryPath(root, entrypoint).catch(() => null) : null
      const projectRoot = entrypointPath ? await resolveProjectRoot(root, entrypointPath) : await resolveProjectRoot(root, null)
      return NextResponse.json({
        ok: true,
        stagedUpload: {
          id,
          name,
          summary,
          runtime,
          entryMode,
          entrypoint,
          uploadRoot: root,
          projectRoot,
          selectedBundle: uploadedArchive ? "archive" : "directory",
        },
      })
    }

    const built = await buildUploadCandidate({
      root,
      id,
      name,
      summary,
      runtime,
      entryMode,
      entrypoint,
      args: parseLines(form.get("args")),
      env: parseEnv(form.get("env")),
    })
    let candidate = built.candidate
    const projectRoot = built.projectRoot
    const bootstrap = built.bootstrap
    let preflight = await preflightMcpServer(installCandidateFrom(candidate))
    let repair: McpPreflightRepairResult | null = null

    if (!preflight.ok && repairEnabled) {
      try {
        repair = await repairUploadedMcpServerWithLlm({
          uploadRoot: root,
          projectRoot,
          server: installCandidateFrom(candidate),
          preflight,
          dependencyLogs: bootstrap.logs,
          sandboxId: sandboxId || null,
        })
        if (repair.updatedServer) {
          candidate = {
            ...candidate,
            command: repair.updatedServer.command,
            args: repair.updatedServer.args,
            env: repair.updatedServer.env,
          }
        }
        if (repair.ok) {
          preflight = await preflightMcpServer(installCandidateFrom(candidate))
        }
      } catch (error) {
        repair = {
          attempted: true,
          ok: false,
          provider: "openai-compatible",
          model: "",
          baseUrl: process.env.MCP_PREFLIGHT_LLM_BASE_URL || process.env.OPENAI_BASE_URL || process.env.VLLM_BASE_URL || "",
          summary: "LLM-assisted repair could not complete.",
          changes: [],
          error: error instanceof Error ? error.message : "MCP repair failed",
        }
      }
    }

    const server = await installMcpServer({
      ...candidate,
      enabled: preflight.ok,
      tags: preflight.ok ? candidate.tags : [...candidate.tags, "preflight-failed"],
    })

    return NextResponse.json({
      ok: true,
      server,
      uploadRoot: root,
      projectRoot,
      dependencyInstall: {
        kind: bootstrap.kind,
        logs: bootstrap.logs,
      },
      preflight,
      repair,
      ...(await listMcpServers()),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload MCP server"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
