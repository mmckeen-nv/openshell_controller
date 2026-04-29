import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const HOME = process.env.HOME || ""

function firstExisting(candidates: Array<string | undefined>, fallback: string) {
  return candidates.filter((value): value is string => Boolean(value)).find((candidate) => existsSync(candidate)) || fallback
}

function unique(values: Array<string | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

function inferHomeFromLocalBin(commandPath: string) {
  const suffix = "/.local/bin/openshell"
  return commandPath.endsWith(suffix) ? commandPath.slice(0, -suffix.length) : undefined
}

function safeIsDirectory(candidate: string) {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function homeChildDirectories() {
  if (!HOME || !safeIsDirectory(HOME)) return []
  try {
    return readdirSync(HOME, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(HOME, entry.name))
      .filter((directory) => !/(^|\/)(node_modules|\.cache|\.npm|\.local\/share\/Trash)$/.test(directory))
  } catch {
    return []
  }
}

function discoverHomeFiles(relativePath: string) {
  const found: string[] = []
  for (const directory of homeChildDirectories()) {
    const direct = path.join(directory, relativePath)
    if (existsSync(direct)) found.push(direct)

    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (["node_modules", ".git", ".next", "dist", "build"].includes(entry.name)) continue
        const nested = path.join(directory, entry.name, relativePath)
        if (existsSync(nested)) found.push(nested)
      }
    } catch {
      // Ignore unreadable home subdirectories.
    }
  }
  return found
}

const OPENSHELL_BIN_CANDIDATES = unique([
  process.env.OPENSHELL_BIN,
  HOME ? path.join(HOME, ".local/bin/openshell") : undefined,
  "/opt/homebrew/bin/openshell",
  "/usr/local/bin/openshell",
])

export const OPENSHELL_BIN = firstExisting(OPENSHELL_BIN_CANDIDATES, "openshell")

function homeWithOpenShellConfig(candidates: Array<string | undefined>) {
  return candidates
    .filter((value): value is string => Boolean(value))
    .find((candidate) => existsSync(path.join(candidate, ".config/openshell")))
}

const INFERRED_OPENSHELL_HOME = inferHomeFromLocalBin(OPENSHELL_BIN)
export const OPENSHELL_HOME = homeWithOpenShellConfig([
  process.env.OPENSHELL_HOME,
  HOME,
  INFERRED_OPENSHELL_HOME,
]) || process.env.OPENSHELL_HOME || INFERRED_OPENSHELL_HOME || HOME

export const OPENSHELL_XDG_CONFIG_HOME = firstExisting([
  process.env.OPENSHELL_XDG_CONFIG_HOME,
  process.env.XDG_CONFIG_HOME && existsSync(path.join(process.env.XDG_CONFIG_HOME, "openshell")) ? process.env.XDG_CONFIG_HOME : undefined,
  OPENSHELL_HOME ? path.join(OPENSHELL_HOME, ".config") : undefined,
], process.env.XDG_CONFIG_HOME || (OPENSHELL_HOME ? path.join(OPENSHELL_HOME, ".config") : ""))

function pathEntries() {
  return [
    process.env.TERMINAL_EXTRA_PATH,
    process.env.OPENSHELL_CONTROL_VENV ? path.join(process.env.OPENSHELL_CONTROL_VENV, "bin") : undefined,
    path.join(process.cwd(), ".venv/bin"),
    OPENSHELL_HOME ? path.join(OPENSHELL_HOME, ".local/bin") : undefined,
    HOME ? path.join(HOME, ".local/bin") : undefined,
    HOME ? path.join(HOME, ".nvm/versions/node/v22.22.2/bin") : undefined,
    HOME ? path.join(HOME, ".nvm/versions/node/v22.22.1/bin") : undefined,
    HOME ? path.join(HOME, ".nemoclaw/source/node_modules/.bin") : undefined,
    HOME ? path.join(HOME, "NemoClaw/node_modules/.bin") : undefined,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    process.env.PATH,
  ].filter((value): value is string => Boolean(value))
}

export const HOST_PATH = unique(pathEntries()).join(":")

export function hostCommandEnv(extra: Record<string, string | undefined> = {}) {
  return {
    ...process.env,
    ...(OPENSHELL_HOME ? { HOME: OPENSHELL_HOME } : {}),
    ...(OPENSHELL_XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: OPENSHELL_XDG_CONFIG_HOME } : {}),
    PATH: HOST_PATH,
    NO_COLOR: "1",
    CLICOLOR: "0",
    CLICOLOR_FORCE: "0",
    ...extra,
  }
}

export const NODE_BIN = firstExisting([
  process.env.NODE_BIN,
  HOME ? path.join(HOME, ".nvm/versions/node/v22.22.2/bin/node") : undefined,
  HOME ? path.join(HOME, ".nvm/versions/node/v22.22.1/bin/node") : undefined,
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
], "node")

export const OPENCLAW_BIN = firstExisting([
  process.env.OPENCLAW_BIN,
  HOME ? path.join(HOME, ".local/bin/openclaw") : undefined,
  HOME ? path.join(HOME, ".nemoclaw/source/node_modules/.bin/openclaw") : undefined,
  HOME ? path.join(HOME, "NemoClaw/node_modules/.bin/openclaw") : undefined,
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
], "openclaw")

export const NEMOCLAW_BIN_CANDIDATES = unique([
  process.env.NEMOCLAW_BIN,
  HOME ? path.join(HOME, ".local/bin/nemoclaw") : undefined,
  HOME ? path.join(HOME, ".nemoclaw/source/bin/nemoclaw.js") : undefined,
  HOME ? path.join(HOME, "NemoClaw/bin/nemoclaw.js") : undefined,
  HOME ? path.join(HOME, "nemoclaw/bin/nemoclaw.js") : undefined,
  HOME ? path.join(HOME, "nemoclaw.js") : undefined,
  ...discoverHomeFiles("bin/nemoclaw.js"),
  HOME ? path.join(HOME, ".nvm/versions/node/v22.22.2/bin/nemoclaw") : undefined,
  "/opt/homebrew/bin/nemoclaw",
  "/usr/local/bin/nemoclaw",
])
export const NEMOCLAW_BIN = firstExisting(NEMOCLAW_BIN_CANDIDATES, "nemoclaw")

export const NEMOCLAW_SETUP_CANDIDATES = unique([
  process.env.NEMOCLAW_SETUP,
  HOME ? path.join(HOME, ".nemoclaw/source/scripts/setup.sh") : undefined,
  HOME ? path.join(HOME, "NemoClaw/scripts/setup.sh") : undefined,
  HOME ? path.join(HOME, "nemoclaw/scripts/setup.sh") : undefined,
  ...discoverHomeFiles("scripts/setup.sh"),
])
export const NEMOCLAW_SETUP = firstExisting(NEMOCLAW_SETUP_CANDIDATES, "")

export const NEMOCLAW_CWD_CANDIDATES = unique([
  process.env.NEMOCLAW_CWD,
  HOME ? path.join(HOME, ".nemoclaw/source") : undefined,
  NEMOCLAW_SETUP ? path.dirname(path.dirname(NEMOCLAW_SETUP)) : undefined,
  NEMOCLAW_BIN.includes("/") ? path.dirname(path.dirname(NEMOCLAW_BIN)) : undefined,
  HOME ? path.join(HOME, "NemoClaw") : undefined,
  HOME ? path.join(HOME, "nemoclaw") : undefined,
])
export const NEMOCLAW_CWD = firstExisting(NEMOCLAW_CWD_CANDIDATES, process.cwd())

export function commandExists(command: string) {
  return command.includes("/") ? existsSync(command) : true
}
