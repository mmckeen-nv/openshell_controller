import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { parseCookieHeader } from '../app/lib/auth/policy.mjs'

// Runtime regression guard for the OpenClaw dashboard token fix chain
// (commits c35fea5 + 48bbfa5 + a2e8ddb, June 2026).
//
// Companion to dashboard-token-cookie-wins-check.mjs — that test asserts
// the SOURCE-TEXT shape (no `if (!has('token'))` guards, etc). This test
// EXECUTES the functions on synthetic inputs and asserts they actually
// behave the way the source claims to. Catches three failure modes the
// static test misses:
//
//   1. A new code path is added that bypasses the guard — e.g. a refactor
//      sets the token earlier, before withDashboardTokenQuery's set() runs.
//   2. A subtle logic bug — e.g. the right variable name but the wrong
//      branch of an if/else.
//   3. Drift in dependencies — copyHeaders changes its filter list, or
//      filterCookieHeader stops stripping the dashboard cookie.
//
// We extract the function definitions from server.mjs source and execute
// them in a node:vm sandbox so this test doesn't trigger server.mjs's
// top-level await app.prepare() / server.listen(). This is also why the
// test does not import server.mjs directly.

const root = process.cwd()
const serverSource = await readFile(path.join(root, 'server.mjs'), 'utf8')

function extract(pattern, label) {
  const match = serverSource.match(pattern)
  if (!match) {
    throw new Error(
      `dashboard-token-runtime-check: could not locate ${label} in server.mjs — ` +
        `did the source layout change? Update the regex or refactor the function ` +
        `into an importable module.`,
    )
  }
  return match[0]
}

// Extract every piece of state/function we need to exercise the proxy path.
const fragments = [
  extract(
    /^const authCookieName = 'openshell_control_session'/m,
    'authCookieName',
  ),
  extract(
    /^const openClawDashboardTokenCookieName = 'openclaw_dashboard_token'/m,
    'openClawDashboardTokenCookieName',
  ),
  extract(
    /^function filterCookieHeader\([^)]*\)\s*\{[\s\S]*?\n\}/m,
    'filterCookieHeader',
  ),
  extract(
    /^function readCookieValue\([^)]*\)\s*\{[\s\S]*?\n\}/m,
    'readCookieValue',
  ),
  extract(/^function copyHeaders\([^)]*\)\s*\{[\s\S]*?\n\}/m, 'copyHeaders'),
  extract(
    /^function withDashboardTokenQuery\([^)]*\)\s*\{[\s\S]*?\n\}/m,
    'withDashboardTokenQuery',
  ),
  extract(
    /^function copyDashboardWebSocketHeaders\([^)]*\)\s*\{[\s\S]*?\n\}/m,
    'copyDashboardWebSocketHeaders',
  ),
]

// Inject parseCookieHeader from the actual policy module so we are exercising
// the real cookie parser the running server uses.
const ctx = vm.createContext({
  URL,
  Array,
  Object,
  String,
  console,
  parseCookieHeader,
})

vm.runInContext(fragments.join('\n\n'), ctx)

const { withDashboardTokenQuery, copyDashboardWebSocketHeaders } = ctx

// ─────────────────────────────────────────────────────────────────────────────
// 1. withDashboardTokenQuery — cookie wins over URL ?token=
// ─────────────────────────────────────────────────────────────────────────────

// The 2026-06-13 failure: browser opened WS with cached `?token=STALE` from
// localStorage; server.mjs preserved it; gateway rejected with token_mismatch.
{
  const upstream = new URL('ws://127.0.0.1:20049/?token=STALE_FROM_LOCALSTORAGE')
  const result = withDashboardTokenQuery(upstream, 'FRESH_FROM_COOKIE')
  assert.equal(
    result.searchParams.get('token'),
    'FRESH_FROM_COOKIE',
    'withDashboardTokenQuery must REPLACE a stale URL ?token= with the cookie value. ' +
      'If this fails, server.mjs has reintroduced the !searchParams.has("token") ' +
      'guard and "delete-and-recreate-with-same-name" is broken for any browser ' +
      'with cached state. See CLAUDE.md §11 / commit 48bbfa5.',
  )
  assert.equal(
    result.searchParams.get('authToken'),
    null,
    'no authToken alias should appear when only token is set on the input URL',
  )
}

// authToken alias: same SPA caching scenario but using the alternative query name
// the gateway also accepts. The cookie must win and the alias must be removed
// so it cannot be re-interpreted by the gateway.
{
  const upstream = new URL('ws://127.0.0.1:20049/?authToken=STALE_ALIAS')
  const result = withDashboardTokenQuery(upstream, 'FRESH_FROM_COOKIE')
  assert.equal(
    result.searchParams.get('token'),
    'FRESH_FROM_COOKIE',
    'withDashboardTokenQuery must inject the cookie token even when the URL ' +
      'used the ?authToken= alias rather than ?token=',
  )
  assert.equal(
    result.searchParams.get('authToken'),
    null,
    'withDashboardTokenQuery must DELETE any inbound ?authToken= so the alias ' +
      "cannot override the cookie's token after it is set. See CLAUDE.md §11.",
  )
}

// Both token and authToken present (paranoid SPA): cookie still wins, alias gone.
{
  const upstream = new URL(
    'ws://127.0.0.1:20049/?token=STALE_TOKEN&authToken=STALE_ALIAS',
  )
  const result = withDashboardTokenQuery(upstream, 'FRESH_FROM_COOKIE')
  assert.equal(result.searchParams.get('token'), 'FRESH_FROM_COOKIE')
  assert.equal(result.searchParams.get('authToken'), null)
}

// Clean URL + cookie present: cookie gets added (the happy path).
{
  const upstream = new URL('ws://127.0.0.1:20049/')
  const result = withDashboardTokenQuery(upstream, 'FRESH_FROM_COOKIE')
  assert.equal(
    result.searchParams.get('token'),
    'FRESH_FROM_COOKIE',
    'withDashboardTokenQuery must add the cookie token when the URL has none',
  )
}

// No cookie + URL has token: leave URL alone (cookie-wins only applies when we
// have a cookie token to win with).
{
  const upstream = new URL('ws://127.0.0.1:20049/?token=URL_ONLY')
  const result = withDashboardTokenQuery(upstream, null)
  assert.equal(
    result.searchParams.get('token'),
    'URL_ONLY',
    'withDashboardTokenQuery must preserve the URL token when no cookie is present',
  )
}

// No cookie + no URL token: clean URL out.
{
  const upstream = new URL('ws://127.0.0.1:20049/')
  const result = withDashboardTokenQuery(upstream, null)
  assert.equal(result.searchParams.get('token'), null)
  assert.equal(result.searchParams.get('authToken'), null)
}

// Path and host must be preserved across token rewrites — guard against an
// accidental URL reassignment that wipes them.
{
  const upstream = new URL(
    'wss://controller.example.com/api/openshell/instances/sandbox-20049-foo/dashboard/proxy?token=STALE&other=keepme',
  )
  const result = withDashboardTokenQuery(upstream, 'FRESH')
  assert.equal(result.host, 'controller.example.com')
  assert.equal(
    result.pathname,
    '/api/openshell/instances/sandbox-20049-foo/dashboard/proxy',
  )
  assert.equal(result.searchParams.get('token'), 'FRESH')
  assert.equal(
    result.searchParams.get('other'),
    'keepme',
    'unrelated query params must survive token rewriting',
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. copyDashboardWebSocketHeaders — cookie wins over Authorization header
// ─────────────────────────────────────────────────────────────────────────────

function mockReq(headers) {
  return { headers }
}

// The 2026-06-13 failure mode: browser replayed a stale Bearer token in the
// Authorization header from a cached session. server.mjs preserved it (the
// !headers.authorization guard). Gateway rejected as token_mismatch.
{
  const req = mockReq({
    cookie:
      'openshell_control_session=session_value; openclaw_dashboard_token=FRESH_FROM_COOKIE',
    authorization: 'Bearer STALE_FROM_BROWSER',
    'x-forwarded-user': 'attacker@example.com', // must be stripped
  })
  const out = copyDashboardWebSocketHeaders(req, 'http://127.0.0.1:18789')
  assert.equal(
    out.authorization,
    'Bearer FRESH_FROM_COOKIE',
    'copyDashboardWebSocketHeaders must OVERRIDE a stale browser-supplied ' +
      'Authorization header with the cookie value. If this fails, server.mjs ' +
      'has reintroduced the !headers.authorization guard. See CLAUDE.md §11 ' +
      '/ commit a2e8ddb.',
  )
  assert.equal(
    out['x-forwarded-user'],
    undefined,
    "x-forwarded-user from the client must NEVER be forwarded upstream — " +
      "it's set only by trusted middleware and downstream services may trust it",
  )
}

// No client Authorization at all + cookie present: cookie still gets bridged in.
{
  const req = mockReq({
    cookie: 'openclaw_dashboard_token=FRESH_FROM_COOKIE',
  })
  const out = copyDashboardWebSocketHeaders(req, 'http://127.0.0.1:18789')
  assert.equal(
    out.authorization,
    'Bearer FRESH_FROM_COOKIE',
    'copyDashboardWebSocketHeaders must SYNTHESIZE Authorization from the cookie ' +
      'when none was supplied by the client',
  )
}

// No cookie at all: no Authorization synthesized, no client value to forward.
{
  const req = mockReq({
    cookie: 'openshell_control_session=session_value',
  })
  const out = copyDashboardWebSocketHeaders(req, 'http://127.0.0.1:18789')
  assert.equal(
    out.authorization,
    undefined,
    'copyDashboardWebSocketHeaders must NOT invent an Authorization when no ' +
      'cookie is present — the upstream would reject anyway and a fabricated ' +
      'header would mask the real "no token" failure mode',
  )
}

// Cookie + Origin/Referer + Cookie filtering: the controller's own session cookie
// must NOT be forwarded to the OpenClaw gateway (defence in depth — strips
// privileged controller state from leaking to a less-trusted upstream).
{
  const req = mockReq({
    cookie:
      'openshell_control_session=PRIVILEGED; openclaw_dashboard_token=FRESH; other_cookie=harmless',
  })
  const out = copyDashboardWebSocketHeaders(req, 'http://127.0.0.1:18789')
  assert.ok(
    out.cookie === undefined || !out.cookie.includes('openshell_control_session'),
    'copyDashboardWebSocketHeaders must strip openshell_control_session before ' +
      'forwarding cookies upstream',
  )
  assert.ok(
    out.cookie === undefined || !out.cookie.includes('openclaw_dashboard_token'),
    'copyDashboardWebSocketHeaders must strip openclaw_dashboard_token from the ' +
      'forwarded Cookie header — the gateway reads it from Authorization, never ' +
      "from cookies, and leaking it as a cookie risks the upstream's own log " +
      'redaction missing it',
  )
  // Unrelated cookies pass through unchanged.
  assert.ok(
    out.cookie && out.cookie.includes('other_cookie=harmless'),
    'copyDashboardWebSocketHeaders must NOT strip unrelated cookies — only the ' +
      'two controller-managed ones',
  )
  // Origin must be rewritten to the gateway's control UI origin (not the browser's).
  assert.equal(
    out.origin,
    'http://127.0.0.1:18789',
    'copyDashboardWebSocketHeaders must rewrite Origin to the gateway control UI origin',
  )
}

// Multi-cookie ordering: openclaw_dashboard_token can appear anywhere in the
// cookie string. Make sure readCookieValue + the resulting Authorization work
// regardless of position.
for (const cookieStr of [
  'openclaw_dashboard_token=POSITION_FIRST; other=x',
  'other=x; openclaw_dashboard_token=POSITION_MIDDLE; another=y',
  'other=x; another=y; openclaw_dashboard_token=POSITION_LAST',
]) {
  const req = mockReq({ cookie: cookieStr })
  const out = copyDashboardWebSocketHeaders(req, 'http://127.0.0.1:18789')
  const expected = cookieStr.match(/openclaw_dashboard_token=([^;]+)/)[1]
  assert.equal(
    out.authorization,
    `Bearer ${expected}`,
    `cookie at position "${cookieStr}" should still produce Bearer ${expected}`,
  )
}

console.log(
  'dashboard-token-runtime-check: PASS dashboard token cookie-wins runtime behaviour intact',
)
