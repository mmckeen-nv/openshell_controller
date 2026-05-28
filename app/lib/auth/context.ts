// AuthContext: discriminated union representing the verified identity of a
// request. Callers (middleware, route handlers) should derive policy
// decisions from this rather than reading cookies directly.

import { NextRequest } from "next/server"
import { verifyOperatorSession, verifyCFJWT } from "./edge"
import { emailFromCFPayload, COOKIE_NAME, CF_COOKIE_NAME } from "./policy.mjs"

export type AuthContext =
  | { kind: "disabled" }
  | { kind: "anonymous" }
  | { kind: "operator" }
  | { kind: "mcpauth"; email: string }

export function getOperatorSecret() {
  return process.env.OPENSHELL_CONTROL_AUTH_SECRET || process.env.OPENSHELL_CONTROL_PASSWORD || ""
}

export function getCFAuthSecret() {
  return process.env.MCPAUTH_JWT_SECRET || process.env.CF_AUTH_JWT_SECRET || ""
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

async function resolveMcpAuth(cookies: CookieReader): Promise<string | null> {
  const value = cookies.get(CF_COOKIE_NAME)?.value
  if (!value) return null
  const payload = await verifyCFJWT(value, getCFAuthSecret())
  return payload ? emailFromCFPayload(payload) : null
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

  const email = await resolveMcpAuth(cookies)
  if (email) return { kind: "mcpauth", email }

  return { kind: "anonymous" }
}

/**
 * Convenience: returns true iff the request carries valid operator credentials
 * (or auth is disabled). Useful for route handlers that don't care about the
 * MCPAuth case.
 */
export async function isOperator(request: NextRequest): Promise<boolean> {
  if (isAuthDisabled()) return true
  return resolveOperator(request.cookies)
}

/**
 * Convenience: returns the MCPAuth user's email iff present and verified.
 */
export async function mcpAuthEmail(request: NextRequest): Promise<string | null> {
  return resolveMcpAuth(request.cookies)
}
