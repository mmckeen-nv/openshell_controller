// SPDX-License-Identifier: Apache-2.0
//
// Runtime-agnostic auth policy helpers shared between:
//   - app/lib/auth/edge.ts (Edge runtime: middleware, route handlers)
//   - server.mjs           (Node runtime: WebSocket upgrade handler)
//
// This file is plain ESM so it can be imported by both the Next.js bundle
// (Edge/Node) and the raw Node custom server (server.mjs) without going
// through TypeScript or webpack. Crypto primitives live in the per-runtime
// adapters; only pure logic (parsing, allowlists, expiry checks) lives here.

export const COOKIE_NAME = 'openshell_control_session'
// Cookie set by /api/auth/callback after the OAuth handshake. We migrated
// away from the historical 'CF_Authorization' name (which implied
// Cloudflare Access semantics — JWKS validation against a CF-managed key)
// to a neutral name that describes what the cookie actually is: a session
// minted by our OAuth callback for the verified IDP user.
export const OAUTH_COOKIE_NAME = 'oauth_session'
// Legacy alias read for backwards compatibility with sessions issued by an
// older controller version. New cookies are always written under the new
// name; once a deployment is fully rolled out this can be removed.
export const LEGACY_OAUTH_COOKIE_NAME = 'CF_Authorization'
export const SESSION_TTL_SECONDS = 12 * 60 * 60

// ── base64url helpers (runtime-agnostic) ────────────────────────────────

export function base64UrlEncode(value) {
  // Accepts a binary string ("\x00\xff\x10..."). Use btoa in Edge, Buffer in Node.
  if (typeof btoa === 'function') {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }
  // eslint-disable-next-line no-undef
  return Buffer.from(value, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function base64UrlDecode(value) {
  const padded = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  if (typeof atob === 'function') {
    return atob(padded)
  }
  // eslint-disable-next-line no-undef
  return Buffer.from(padded, 'base64').toString('binary')
}

// ── Constant-time equality ──────────────────────────────────────────────

export function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return diff === 0
}

// ── Session cookie parsing ──────────────────────────────────────────────

/**
 * Splits a session cookie value into its (payload, signature) parts without
 * any verification. Use `verifySessionPayload` after computing the expected
 * signature via the runtime-specific HMAC adapter.
 *
 * @param {string | undefined | null} value
 * @returns {{ payload: string, signature: string } | null}
 */
export function splitSessionCookie(value) {
  if (typeof value !== 'string' || !value) return null
  const parts = value.split('.')
  if (parts.length !== 2) return null
  const [payload, signature] = parts
  if (!payload || !signature) return null
  return { payload, signature }
}

/**
 * Decodes a session payload and verifies it's not expired. The signature
 * MUST already have been verified by the caller against an HMAC of `payload`.
 *
 * @returns The decoded payload object, or null if invalid/expired.
 */
export function decodeAndValidateSessionPayload(encodedPayload) {
  try {
    const json = base64UrlDecode(encodedPayload)
    const parsed = JSON.parse(json)
    if (typeof parsed.exp !== 'number') return null
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null
    return parsed
  } catch {
    return null
  }
}

// ── OAuth session JWT parsing ───────────────────────────────────────────

/**
 * Splits a compact JWT into its three encoded segments without verification.
 * @param {string | undefined | null} token
 */
export function splitJWT(token) {
  if (typeof token !== 'string' || !token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  if (!header || !payload || !signature) return null
  return { header, payload, signature, signingInput: `${header}.${payload}` }
}

/**
 * Decodes and validates a JWT payload's `exp` claim. The signature MUST
 * already have been verified by the caller.
 */
export function decodeAndValidateJWTPayload(encodedPayload) {
  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload))
    const now = Math.floor(Date.now() / 1000)
    if (typeof payload.exp === 'number' && payload.exp < now) return null
    return payload
  } catch {
    return null
  }
}

/**
 * Extracts the user email from a verified OAuth JWT payload. Falls back to `sub`.
 */
export function emailFromOAuthPayload(payload) {
  if (!payload || typeof payload !== 'object') return null
  const value = payload.email || payload.sub
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

// ── Sandbox access map ──────────────────────────────────────────────────

/**
 * Parses a CSV string like "sandbox-a:alice@x.com,sandbox-a:bob@x.com,..."
 * into a Map<sandboxName, Set<lowercaseEmail>>.
 */
export function parseSandboxAccessCSV(csv) {
  const map = new Map()
  if (typeof csv !== 'string' || !csv) return map
  for (const pair of csv.split(',')) {
    const trimmed = pair.trim()
    if (!trimmed) continue
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex === -1) continue
    const sandboxName = trimmed.slice(0, colonIndex).trim()
    const email = trimmed.slice(colonIndex + 1).trim().toLowerCase()
    if (sandboxName && email) {
      if (!map.has(sandboxName)) map.set(sandboxName, new Set())
      map.get(sandboxName).add(email)
    }
  }
  return map
}

/**
 * Builds the canonical CSV representation from an entries array.
 */
export function serializeSandboxAccessEntries(entries) {
  if (!Array.isArray(entries)) return ''
  return entries
    .filter((e) => e && typeof e === 'object' && e.sandboxName && e.email)
    .map((e) => `${String(e.sandboxName).trim()}:${String(e.email).trim().toLowerCase()}`)
    .join(',')
}

/**
 * Returns true iff `email` is authorized for `sandboxId` in the parsed access
 * map. Case-insensitive on emails.
 */
export function isEmailAuthorizedForSandbox(map, email, sandboxId) {
  if (!sandboxId || !email || !(map instanceof Map)) return false
  const authorizedEmails = map.get(sandboxId)
  if (!authorizedEmails) return false
  return authorizedEmails.has(String(email).toLowerCase())
}

// ── Cookie helpers ──────────────────────────────────────────────────────

/**
 * Parses a Cookie header into a plain object. Tolerates missing values.
 */
export function parseCookieHeader(header) {
  const out = {}
  if (typeof header !== 'string' || !header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name) continue
    try {
      out[name] = decodeURIComponent(value)
    } catch {
      out[name] = value
    }
  }
  return out
}

// ── Sandbox ID extraction from request URLs ─────────────────────────────

/**
 * Pulls the sandbox name out of a URL whose path matches the
 * /api/openshell/instances/{instanceId}/dashboard/proxy/... pattern
 * (instance ID format is sandbox-{port}-{name}), or falls back to a
 * `?sandboxId=` query param. Returns null if neither matches.
 */
export function extractSandboxIdFromUrl(pathname, searchParams) {
  if (typeof pathname === 'string' && pathname.startsWith('/api/openshell/instances/')) {
    const parts = pathname.split('/')
    const instanceId = parts[4]
    if (instanceId) {
      const decoded = decodeURIComponent(instanceId)
      const match = decoded.match(/^sandbox-(\d+)-(.+)$/)
      if (match) return match[2]
    }
  }
  if (searchParams && typeof searchParams.get === 'function') {
    const v = searchParams.get('sandboxId')
    if (v) return v
  }
  return null
}
