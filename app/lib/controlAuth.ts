const COOKIE_NAME = "openshell_control_session"
const SESSION_TTL_SECONDS = 12 * 60 * 60

type SessionPayload = {
  sub: string
  iat: number
  exp: number
}

function base64UrlEncode(value: string) {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  return atob(padded)
}

function getSecret() {
  return process.env.OPENSHELL_CONTROL_AUTH_SECRET || process.env.OPENSHELL_CONTROL_PASSWORD || ""
}

function isDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.OPENSHELL_CONTROL_AUTH_DISABLED || "")
}

async function hmac(payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  const bytes = Array.from(new Uint8Array(signature), (byte) => String.fromCharCode(byte)).join("")
  return base64UrlEncode(bytes)
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
}

export function getAuthSettings() {
  return {
    cookieName: COOKIE_NAME,
    ttlSeconds: SESSION_TTL_SECONDS,
    disabled: isDisabled(),
    configured: Boolean(process.env.OPENSHELL_CONTROL_PASSWORD || isDisabled()),
  }
}

export async function createSessionCookieValue() {
  const now = Math.floor(Date.now() / 1000)
  const payload: SessionPayload = {
    sub: "operator",
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  return `${encodedPayload}.${await hmac(encodedPayload)}`
}

export async function verifySessionCookieValue(value: string | undefined) {
  const settings = getAuthSettings()
  if (settings.disabled) return true
  if (!settings.configured || !value) return false

  const [payload, signature] = value.split(".")
  if (!payload || !signature) return false
  const expected = await hmac(payload)
  if (!constantTimeEqual(signature, expected)) return false

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as Partial<SessionPayload>
    return typeof parsed.exp === "number" && parsed.exp > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

export async function verifyPassword(password: string) {
  const expected = process.env.OPENSHELL_CONTROL_PASSWORD || ""
  if (!expected) return false
  return constantTimeEqual(password, expected)
}

export async function verifyRecoveryToken(token: string) {
  const expected = process.env.OPENSHELL_CONTROL_RECOVERY_TOKEN || ""
  if (!expected) return false
  return constantTimeEqual(token, expected)
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
}
