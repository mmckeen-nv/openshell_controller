import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const ENV_PATH = path.join(process.cwd(), ".env.local")

function quoteEnvValue(value: string) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

async function readEnvFile() {
  if (!existsSync(ENV_PATH)) return ""
  return readFile(ENV_PATH, "utf8")
}

function upsertEnv(content: string, key: string, value: string) {
  const line = `${key}=${quoteEnvValue(value)}`
  const matcher = new RegExp(`^${key}=.*$`, "m")
  if (matcher.test(content)) return content.replace(matcher, line)
  return `${content.trimEnd()}${content.trim() ? "\n" : ""}${line}\n`
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
