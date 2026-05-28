// Edge-runtime crypto adapter for app/lib/auth/policy.mjs.
//
// Web Crypto is async-only. The functions exported here mirror the surface
// of policy.mjs's parsers and add HMAC sign+verify backed by Web Crypto.

import {
  base64UrlEncode,
  base64UrlDecode,
  constantTimeEqual,
  splitSessionCookie,
  decodeAndValidateSessionPayload,
  splitJWT,
  decodeAndValidateJWTPayload,
  emailFromOAuthPayload,
} from "./policy.mjs"

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
}

export async function hmacSign(secret: string, payload: string): Promise<string> {
  if (!secret) return ""
  const key = await importHmacKey(secret)
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  const bytes = Array.from(new Uint8Array(signature), (byte) => String.fromCharCode(byte)).join("")
  return base64UrlEncode(bytes)
}

/**
 * Verify and decode an HMAC-signed operator session cookie value.
 * Returns the decoded payload on success, null on any failure.
 */
export async function verifyOperatorSession(value: string | undefined | null, secret: string) {
  if (!secret) return null
  const parts = splitSessionCookie(value || "")
  if (!parts) return null
  const expected = await hmacSign(secret, parts.payload)
  if (!expected || !constantTimeEqual(parts.signature, expected)) return null
  return decodeAndValidateSessionPayload(parts.payload)
}

/**
 * Verify an HS256 JWT (the OAuth session cookie minted by /api/auth/callback)
 * and return its payload, or null on any failure (including missing secret).
 */
export async function verifyOAuthJWT(token: string | undefined | null, secret: string) {
  if (!secret) return null
  const parts = splitJWT(token || "")
  if (!parts) return null
  const expected = await hmacSign(secret, parts.signingInput)
  if (!expected || expected !== parts.signature) return null
  return decodeAndValidateJWTPayload(parts.payload)
}

export async function mintHS256JWT(secret: string, payload: Record<string, unknown>) {
  if (!secret) throw new Error("Cannot mint JWT without a secret")
  const header = { alg: "HS256", typ: "JWT" }
  const headerB64 = base64UrlEncode(JSON.stringify(header))
  const payloadB64 = base64UrlEncode(JSON.stringify(payload))
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = await hmacSign(secret, signingInput)
  return `${signingInput}.${signature}`
}

export { emailFromOAuthPayload, base64UrlEncode, base64UrlDecode }
