export const COOKIE_NAME: "openshell_control_session"
export const CF_COOKIE_NAME: "CF_Authorization"
export const SESSION_TTL_SECONDS: 43200

export function base64UrlEncode(value: string): string
export function base64UrlDecode(value: string): string
export function constantTimeEqual(left: string, right: string): boolean

export type SessionCookieParts = { payload: string; signature: string }
export function splitSessionCookie(value: string | undefined | null): SessionCookieParts | null
export function decodeAndValidateSessionPayload(encodedPayload: string): { sub?: string; iat?: number; exp?: number } | null

export type JWTParts = { header: string; payload: string; signature: string; signingInput: string }
export function splitJWT(token: string | undefined | null): JWTParts | null
export function decodeAndValidateJWTPayload(encodedPayload: string): Record<string, unknown> | null
export function emailFromCFPayload(payload: unknown): string | null

export type SandboxAccessMap = Map<string, Set<string>>
export type SandboxAccessEntry = { sandboxName: string; email: string }
export function parseSandboxAccessCSV(csv: string | undefined | null): SandboxAccessMap
export function serializeSandboxAccessEntries(entries: SandboxAccessEntry[]): string
export function isEmailAuthorizedForSandbox(map: SandboxAccessMap, email: string | null | undefined, sandboxId: string | null | undefined): boolean

export function parseCookieHeader(header: string | undefined | null): Record<string, string>

export interface ExtractSandboxSearchParams { get(key: string): string | null }
export function extractSandboxIdFromUrl(pathname: string | undefined | null, searchParams?: ExtractSandboxSearchParams | null): string | null
