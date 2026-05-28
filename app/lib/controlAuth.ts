// Thin compatibility layer over app/lib/auth/. Kept so existing callers
// (route handlers, middleware) keep working with no edits. New code should
// import directly from `@/app/lib/auth/...` instead.
//
// Sandbox access lookup now reads through the file-backed store with a CSV
// env-var fallback (see app/lib/auth/sandboxAccessStore.ts), so changes to
// the access list no longer require a controller restart.

import { hmacSign, verifyOperatorSession, mintHS256JWT, verifyCFJWT } from "./auth/edge"
import {
  base64UrlEncode,
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  parseSandboxAccessCSV,
  isEmailAuthorizedForSandbox as _isEmailAuthorizedForSandbox,
} from "./auth/policy.mjs"
import { getOperatorSecret, getCFAuthSecret as _getCFAuthSecret, isAuthDisabled, isAuthConfigured } from "./auth/context"
import { getSandboxAccessMap as readSandboxAccessMap } from "./auth/sandboxAccessStore"

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

export function getAuthSettings() {
  return {
    cookieName: COOKIE_NAME,
    ttlSeconds: SESSION_TTL_SECONDS,
    disabled: isAuthDisabled(),
    configured: isAuthConfigured(),
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
  const signature = await hmacSign(getOperatorSecret(), encodedPayload)
  return `${encodedPayload}.${signature}`
}

export async function verifySessionCookieValue(value: string | undefined) {
  if (isAuthDisabled()) return true
  if (!isAuthConfigured() || !value) return false
  const payload = await verifyOperatorSession(value, getOperatorSecret())
  return Boolean(payload)
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return diff === 0
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
  return _getCFAuthSecret()
}

export async function verifyCFAuthorizationJWT(token: string | undefined) {
  return verifyCFJWT(token || "", getCFAuthSecret())
}

/**
 * Reads the sandbox-access map. Backed by a JSON file when present, with the
 * SANDBOX_ACCESS_USERS env var as a fallback. Either source is parsed via the
 * shared policy helpers so the format stays in sync between Edge and Node.
 */
export function getSandboxAccessMap(): Map<string, Set<string>> {
  const fromStore = readSandboxAccessMap()
  if (fromStore && fromStore.size > 0) return fromStore
  return parseSandboxAccessCSV(process.env.SANDBOX_ACCESS_USERS || "")
}

export function isUserAuthorizedForSandbox(email: string, sandboxId: string | null): boolean {
  return _isEmailAuthorizedForSandbox(getSandboxAccessMap(), email, sandboxId)
}

export async function mintCFAuthorizationJWT(email: string, scopes: string[] = [], ttlSeconds: number = 86400) {
  const secret = getCFAuthSecret()
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    sub: email,
    email,
    scopes,
    iat: now,
    exp: now + ttlSeconds,
  }
  return mintHS256JWT(secret, payload)
}
