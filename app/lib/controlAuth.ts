const COOKIE_NAME = "openshell_control_session"
const SESSION_TTL_SECONDS = 12 * 60 * 60

type CookieSecurityRequest = {
  headers: Pick<Headers, "get">
  nextUrl?: {
    protocol: string
  }
}

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

function envFlag(value: string | undefined) {
  if (!value) return null
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  return null
}

function firstForwardedValue(value: string | null) {
  return value?.split(",")[0]?.trim().toLowerCase() || ""
}

function publicBaseUsesHttps() {
  if (!process.env.PUBLIC_BASE_URL) return false
  try {
    return new URL(process.env.PUBLIC_BASE_URL).protocol === "https:"
  } catch {
    return false
  }
}

export function shouldUseSecureSessionCookie(request?: CookieSecurityRequest) {
  const forced = envFlag(process.env.OPENSHELL_CONTROL_COOKIE_SECURE)
  if (forced !== null) return forced

  const forwardedProto = request ? firstForwardedValue(request.headers.get("x-forwarded-proto")) : ""
  if (forwardedProto) return forwardedProto === "https"

  if (request?.nextUrl?.protocol === "https:") return true
  return publicBaseUsesHttps()
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
  secure: shouldUseSecureSessionCookie(),
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
}

export function sessionCookieOptionsForRequest(request: CookieSecurityRequest) {
  return {
    ...sessionCookieOptions,
    secure: shouldUseSecureSessionCookie(request),
  }
}

export function getCFAuthSecret() {
  return process.env.MCPAUTH_JWT_SECRET || process.env.CF_AUTH_JWT_SECRET || "my-secret-key"
}

export async function verifyCFAuthorizationJWT(token: string | undefined) {
  if (!token) return null

  const parts = token.split(".")
  if (parts.length !== 3) return null

  const [headerB64, payloadB64, signatureB64] = parts

  try {
    const signingInput = `${headerB64}.${payloadB64}`
    const secret = getCFAuthSecret()
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput))
    const sigBytes = Array.from(new Uint8Array(sigBuffer), (byte) => String.fromCharCode(byte)).join("")
    const expectedSignatureB64 = base64UrlEncode(sigBytes)

    if (signatureB64 !== expectedSignatureB64) {
      return null
    }

    const payload = JSON.parse(base64UrlDecode(payloadB64))
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp === "number" && payload.exp < now) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

export function getSandboxAccessMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const env = process.env.SANDBOX_ACCESS_USERS || ""
  if (!env) return map

  const pairs = env.split(",")
  for (const pair of pairs) {
    const [sandboxName, email] = pair.split(":")
    if (sandboxName && email) {
      const trimmedSandbox = sandboxName.trim()
      const trimmedEmail = email.trim().toLowerCase()
      if (!map.has(trimmedSandbox)) {
        map.set(trimmedSandbox, new Set())
      }
      map.get(trimmedSandbox)!.add(trimmedEmail)
    }
  }
  return map
}

export function isUserAuthorizedForSandbox(email: string, sandboxId: string | null): boolean {
  if (!sandboxId) return false
  const map = getSandboxAccessMap()
  const authorizedEmails = map.get(sandboxId)
  if (!authorizedEmails) return false
  return authorizedEmails.has(email.toLowerCase())
}

export async function mintCFAuthorizationJWT(email: string, scopes: string[] = [], ttlSeconds: number = 86400) {
  const secret = getCFAuthSecret()
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: email,
    email: email,
    scopes: scopes,
    iat: now,
    exp: now + ttlSeconds,
  }

  const header = { alg: "HS256", typ: "JWT" }
  const headerB64 = base64UrlEncode(JSON.stringify(header))
  const payloadB64 = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput))
  const sigBytes = Array.from(new Uint8Array(sigBuffer), (byte) => String.fromCharCode(byte)).join("")
  const signatureB64 = base64UrlEncode(sigBytes)

  return `${signingInput}.${signatureB64}`
}

