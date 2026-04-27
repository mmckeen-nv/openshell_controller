import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const ENV_PATH = path.join(process.cwd(), ".env.local")

function quoteEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function envKeyMatcher(key: string) {
  return new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`)
}

async function readEnvFile() {
  if (!existsSync(ENV_PATH)) return ""
  return readFile(ENV_PATH, "utf8")
}

function upsertEnv(content: string, key: string, value: string) {
  const line = `${key}=${quoteEnvValue(value)}`
  const matcher = envKeyMatcher(key)
  const lines = content.split(/\r?\n/)
  let replaced = false
  const nextLines = lines.filter((existingLine) => {
    if (!matcher.test(existingLine)) return true
    if (replaced) return false
    replaced = true
    return true
  }).map((existingLine) => (matcher.test(existingLine) ? line : existingLine))

  if (!replaced) {
    const trimmed = content.trimEnd()
    return `${trimmed}${trimmed ? "\n" : ""}${line}\n`
  }

  return `${nextLines.join("\n").trimEnd()}\n`
}

export function generateToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url")
}

export async function updateLocalAuthCredentials(password: string) {
  const secret = generateToken(32)
  const recoveryToken = generateToken(24)
  let content = await readEnvFile()
  content = upsertEnv(content, "OPENSHELL_CONTROL_PASSWORD", password)
  content = upsertEnv(content, "OPENSHELL_CONTROL_AUTH_SECRET", secret)
  content = upsertEnv(content, "OPENSHELL_CONTROL_RECOVERY_TOKEN", recoveryToken)
  await writeFile(ENV_PATH, content, "utf8")

  process.env.OPENSHELL_CONTROL_PASSWORD = password
  process.env.OPENSHELL_CONTROL_AUTH_SECRET = secret
  process.env.OPENSHELL_CONTROL_RECOVERY_TOKEN = recoveryToken

  return { recoveryToken }
}
