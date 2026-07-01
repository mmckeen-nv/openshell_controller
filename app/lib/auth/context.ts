// AuthContext: discriminated union representing the verified identity of a
// request. Callers (middleware, route handlers) should derive policy
// decisions from this rather than reading cookies directly.

import { NextRequest } from "next/server"
import { verifyOperatorSession, verifyOAuthJWT } from "./edge"
import {
  emailFromOAuthPayload,
  COOKIE_NAME,
  OAUTH_COOKIE_NAME,
  LEGACY_OAUTH_COOKIE_NAME,
} from "./policy.mjs"

export type AuthContext =
  | { kind: "disabled" }
  | { kind: "anonymous" }
  | { kind: "operator" }
  | { kind: "oauth"; email: string }

export function getOperatorSecret() {
  return process.env.OPENSHELL_CONTROL_AUTH_SECRET || process.env.OPENSHELL_CONTROL_PASSWORD || ""
}

/**
 * Returns the configured OAuth JWT signing secret. Reads env vars in priority
 * order: OAUTH_JWT_SECRET (preferred new name) → MCPAUTH_JWT_SECRET (legacy,
 * still supported for compatibility with existing .env.local files) →
 * CF_AUTH_JWT_SECRET (very old alias).
 */
export function getOAuthSecret() {
  return (
    process.env.OAUTH_JWT_SECRET
    || process.env.MCPAUTH_JWT_SECRET
    || process.env.CF_AUTH_JWT_SECRET
    || ""
  )
}

export function isAuthDisabled() {
  return /^(1|true|yes|on)$/i.test(process.env.OPENSHELL_CONTROL_AUTH_DISABLED || "")
}

export function isAuthConfigured() {
  return Boolean(process.env.OPENSHELL_CONTROL_PASSWORD || isAuthDisabled())
}

type CookieReader = {
  get(name: string): { value: string } | undefined
}

async function resolveOperator(cookies: CookieReader): Promise<boolean> {
  const value = cookies.get(COOKIE_NAME)?.value
  if (!value) return false
  const payload = await verifyOperatorSession(value, getOperatorSecret())
  return Boolean(payload)
}

async function resolveOAuth(cookies: CookieReader): Promise<string | null> {
  // Prefer the new cookie name. Fall back to the legacy `CF_Authorization`
  // name so sessions issued by older controller versions keep working until
  // the user's cookie naturally expires or they sign back in.
  const value =
    cookies.get(OAUTH_COOKIE_NAME)?.value
    || cookies.get(LEGACY_OAUTH_COOKIE_NAME)?.value
  if (!value) return null
  const payload = await verifyOAuthJWT(value, getOAuthSecret())
  return payload ? emailFromOAuthPayload(payload) : null
}

/**
 * Resolves the verified auth identity from a NextRequest. Pure inspection —
 * does not mutate the request. Returns a discriminated union the caller
 * pattern-matches on.
 */
export async function resolveAuthContext(request: NextRequest): Promise<AuthContext> {
  if (isAuthDisabled()) return { kind: "disabled" }

  const cookies = request.cookies
  const isOperator = await resolveOperator(cookies)
  if (isOperator) return { kind: "operator" }

  const email = await resolveOAuth(cookies)
  if (email) return { kind: "oauth", email }

  return { kind: "anonymous" }
}

/**
 * Convenience: returns true iff the request carries valid operator credentials
 * (or auth is disabled). Useful for route handlers that don't care about the
 * OAuth case.
 */
export async function isOperator(request: NextRequest): Promise<boolean> {
  if (isAuthDisabled()) return true
  return resolveOperator(request.cookies)
}

/**
 * Convenience: returns the OAuth user's email iff present and verified.
 */
export async function oauthEmail(request: NextRequest): Promise<string | null> {
  return resolveOAuth(request.cookies)
}
