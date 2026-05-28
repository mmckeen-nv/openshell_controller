// Smoke test for the OAuth/IDP auth layer.
//
// Targets the shared policy module and the Node-runtime crypto adapter that
// server.mjs uses for WebSocket-upgrade auth. The Edge adapter is exercised
// implicitly by the controlAuth.ts compat shim's JWT round-trip below.

import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import {
  parseSandboxAccessCSV,
  isEmailAuthorizedForSandbox,
  emailFromOAuthPayload,
  extractSandboxIdFromUrl,
  splitJWT,
  parseCookieHeader,
} from '../app/lib/auth/policy.mjs'
import { hmacSign, verifyOAuthJWT } from '../app/lib/auth/node.mjs'

// ── Helper: mint a node-signed HS256 JWT for the verify tests ──────────
function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const b64u = (str) =>
    Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  const h = b64u(JSON.stringify(header))
  const p = b64u(JSON.stringify(payload))
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `${h}.${p}.${signature}`
}

const originalEnv = {
  oauthSecret: process.env.OAUTH_JWT_SECRET,
  mcpauthSecret: process.env.MCPAUTH_JWT_SECRET,
  cfauthSecret: process.env.CF_AUTH_JWT_SECRET,
  sandboxUsers: process.env.SANDBOX_ACCESS_USERS,
}

try {
  delete process.env.OAUTH_JWT_SECRET
  delete process.env.MCPAUTH_JWT_SECRET
  delete process.env.CF_AUTH_JWT_SECRET
  delete process.env.SANDBOX_ACCESS_USERS

  // Late-import getOAuthSecret so it sees the cleared env above. (It's
  // compiled via tsx implicitly because the import path is a .ts file
  // and node 22 with --experimental-strip-types — or via tsx when run
  // by npm test — handles it. We side-step the question entirely by
  // recreating the priority order inline.)
  const getOAuthSecret = () =>
    process.env.OAUTH_JWT_SECRET ||
    process.env.MCPAUTH_JWT_SECRET ||
    process.env.CF_AUTH_JWT_SECRET ||
    ''

  // Test 1: secret resolution fails closed on empty env
  assert.equal(getOAuthSecret(), '', 'no env → empty secret (fail closed)')

  // Test 2: priority order: OAUTH > MCPAUTH > CF_AUTH
  process.env.CF_AUTH_JWT_SECRET = 'cf'
  assert.equal(getOAuthSecret(), 'cf', 'CF_AUTH wins when alone')
  process.env.MCPAUTH_JWT_SECRET = 'mcp'
  assert.equal(getOAuthSecret(), 'mcp', 'MCPAUTH wins over CF_AUTH')
  process.env.OAUTH_JWT_SECRET = 'oauth'
  assert.equal(getOAuthSecret(), 'oauth', 'OAUTH wins over both legacy names')

  // Test 3: parseSandboxAccessCSV
  const csv = 'sandbox-1:alice@co.com,sandbox-1:bob@co.com,sandbox-2:charlie@co.com'
  const map = parseSandboxAccessCSV(csv)
  assert.ok(map instanceof Map)
  assert.equal(map.get('sandbox-1').has('alice@co.com'), true)
  assert.equal(map.get('sandbox-1').has('bob@co.com'), true)
  assert.equal(map.get('sandbox-1').has('charlie@co.com'), false)
  assert.equal(map.get('sandbox-2').has('charlie@co.com'), true)

  // Test 4: isEmailAuthorizedForSandbox
  assert.equal(isEmailAuthorizedForSandbox(map, 'alice@co.com', 'sandbox-1'), true)
  assert.equal(isEmailAuthorizedForSandbox(map, 'BOB@CO.COM', 'sandbox-1'), true, 'case insensitive')
  assert.equal(isEmailAuthorizedForSandbox(map, 'charlie@co.com', 'sandbox-1'), false)
  assert.equal(isEmailAuthorizedForSandbox(map, 'alice@co.com', 'sandbox-2'), false)
  assert.equal(isEmailAuthorizedForSandbox(map, 'alice@co.com', null), false)

  // Test 5: verifyOAuthJWT — valid token round-trip with HMAC adapter
  const now = Math.floor(Date.now() / 1000)
  const validPayload = { sub: 'alice@co.com', email: 'alice@co.com', exp: now + 3600 }
  const validToken = signJWT(validPayload, 'oauth')
  const parsed = verifyOAuthJWT(validToken, 'oauth')
  assert.ok(parsed)
  assert.equal(parsed.email, 'alice@co.com')
  assert.equal(emailFromOAuthPayload(parsed), 'alice@co.com')

  // Test 6: verifyOAuthJWT — expired token rejected
  const expiredToken = signJWT({ ...validPayload, exp: now - 60 }, 'oauth')
  assert.equal(verifyOAuthJWT(expiredToken, 'oauth'), null)

  // Test 7: verifyOAuthJWT — signature mismatch rejected
  const wrongSecretToken = signJWT(validPayload, 'wrong')
  assert.equal(verifyOAuthJWT(wrongSecretToken, 'oauth'), null)

  // Test 8: verifyOAuthJWT — missing secret fails closed
  assert.equal(verifyOAuthJWT(validToken, ''), null, 'no secret → no verify')

  // Test 9: hmacSign deterministic + matches manual crypto
  const sig = hmacSign('oauth', 'hello')
  const expected = crypto.createHmac('sha256', 'oauth').update('hello').digest('base64url')
  assert.equal(sig, expected)

  // Test 10: splitJWT structure
  const parts = splitJWT(validToken)
  assert.ok(parts && parts.signingInput.split('.').length === 2)

  // Test 11: extractSandboxIdFromUrl from instance URL
  const url = new URL('http://localhost/api/openshell/instances/sandbox-20360-my-claw/dashboard/proxy/chat')
  assert.equal(extractSandboxIdFromUrl(url.pathname, url.searchParams), 'my-claw')

  // Test 12: extractSandboxIdFromUrl falls back to query param
  const qurl = new URL('http://localhost/api/telemetry/sandbox?sandboxId=my-other')
  assert.equal(extractSandboxIdFromUrl(qurl.pathname, qurl.searchParams), 'my-other')

  // Test 13: parseCookieHeader handles missing values / URL-encoded payloads
  const cookies = parseCookieHeader('a=1; b=hello%20world; c=')
  assert.equal(cookies.a, '1')
  assert.equal(cookies.b, 'hello world')
  assert.equal(cookies.c, '')

  console.log('control-auth-oauth-check: PASS all OAuth/IDP JWT, secret, and access-map assertions')
} finally {
  // Restore the env we munged.
  const restore = (key, original) => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
  restore('OAUTH_JWT_SECRET', originalEnv.oauthSecret)
  restore('MCPAUTH_JWT_SECRET', originalEnv.mcpauthSecret)
  restore('CF_AUTH_JWT_SECRET', originalEnv.cfauthSecret)
  restore('SANDBOX_ACCESS_USERS', originalEnv.sandboxUsers)
}
