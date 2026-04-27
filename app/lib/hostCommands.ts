import { existsSync } from "node:fs"
import path from "node:path"

const HOME = process.env.HOME || ""

function firstExisting(candidates: Array<string | undefined>, fallback: string) {
  return candidates.filter((value): value is string => Boolean(value)).find((candidate) => existsSync(candidate)) || fallback
}

function pathEntries() {
  return [
    process.env.TERMINAL_EXTRA_PATH,
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

export const HOST_PATH = Array.from(new Set(pathEntries())).join(":")

export const NODE_BIN = firstExisting([
  process.env.NODE_BIN,
  HOME ? path.join(HOME, ".nvm/versions/node/v22.22.2/bin/node") : undefined,
  HOME ? path.join(HOME, ".nvm/versions/node/v22.22.1/bin/node") : undefined,
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
], "node")

export const OPENSHELL_BIN = firstExisting([
  process.env.OPENSHELL_BIN,
  HOME ? path.join(HOME, ".local/bin/openshell") : undefined,
  "/opt/homebrew/bin/openshell",
  "/usr/local/bin/openshell",
], "openshell")

export const OPENCLAW_BIN = firstExisting([
  process.env.OPENCLAW_BIN,
  HOME ? path.join(HOME, ".local/bin/openclaw") : undefined,
  HOME ? path.join(HOME, ".nemoclaw/source/node_modules/.bin/openclaw") : undefined,
  HOME ? path.join(HOME, "NemoClaw/node_modules/.bin/openclaw") : undefined,
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
], "openclaw")

export const NEMOCLAW_BIN = firstExisting([
  process.env.NEMOCLAW_BIN,
  HOME ? path.join(HOME, ".local/bin/nemoclaw") : undefined,
  HOME ? path.join(HOME, ".nemoclaw/source/bin/nemoclaw.js") : undefined,
  HOME ? path.join(HOME, "NemoClaw/bin/nemoclaw.js") : undefined,
  HOME ? path.join(HOME, ".nvm/versions/node/v22.22.2/bin/nemoclaw") : undefined,
  "/opt/homebrew/bin/nemoclaw",
  "/usr/local/bin/nemoclaw",
], "nemoclaw")

export const NEMOCLAW_SETUP = firstExisting([
  process.env.NEMOCLAW_SETUP,
  HOME ? path.join(HOME, ".nemoclaw/source/scripts/setup.sh") : undefined,
  HOME ? path.join(HOME, "NemoClaw/scripts/setup.sh") : undefined,
], "")

export const NEMOCLAW_CWD = firstExisting([
  process.env.NEMOCLAW_CWD,
  HOME ? path.join(HOME, ".nemoclaw/source") : undefined,
  HOME ? path.join(HOME, "NemoClaw") : undefined,
], process.cwd())

export function commandExists(command: string) {
  return command.includes("/") ? existsSync(command) : true
}
