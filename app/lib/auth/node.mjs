// Node-runtime crypto adapter for app/lib/auth/policy.mjs.
//
// Used by server.mjs (the custom Next.js Node server) for the WebSocket
// upgrade auth path, where Edge-runtime Web Crypto APIs aren't available.

import crypto from 'node:crypto'
import {
  constantTimeEqual,
  splitSessionCookie,
  decodeAndValidateSessionPayload,
  splitJWT,
  decodeAndValidateJWTPayload,
} from './policy.mjs'

export function hmacSign(secret, payload) {
  if (!secret) return ''
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url')
}

export function verifyOperatorSession(value, secret) {
  if (!secret) return null
  const parts = splitSessionCookie(value || '')
  if (!parts) return null
  const expected = hmacSign(secret, parts.payload)
  if (!expected || !constantTimeEqual(parts.signature, expected)) return null
  return decodeAndValidateSessionPayload(parts.payload)
}

export function verifyCFJWT(token, secret) {
  if (!secret) return null
  const parts = splitJWT(token || '')
  if (!parts) return null
  const expected = hmacSign(secret, parts.signingInput)
  if (!expected || expected !== parts.signature) return null
  return decodeAndValidateJWTPayload(parts.payload)
}

// Re-export the policy helpers server.mjs needs so callers only import from
// this one module.
export {
  parseSandboxAccessCSV,
  isEmailAuthorizedForSandbox,
  emailFromCFPayload,
  extractSandboxIdFromUrl,
  parseCookieHeader,
  COOKIE_NAME,
  CF_COOKIE_NAME,
} from './policy.mjs'
