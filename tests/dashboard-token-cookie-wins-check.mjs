import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Regression guard for commits c35fea5 + 48bbfa5 + a2e8ddb (June 2026).
// See CLAUDE.md §11 — "OpenClaw dashboard token + tunnel architecture".
//
// The OpenClaw Control UI SPA caches a token in localStorage scoped by
// gateway URL and replays it on every WS upgrade — via both the URL
// ?token= query AND an Authorization: Bearer header. When a user deletes
// and recreates a sandbox with the same name, both of those cached values
// are STALE relative to the freshly-minted gateway token, while the
// HttpOnly openclaw_dashboard_token cookie (set by /dashboard/open from
// a live probe) is fresh.
//
// The fix chain enforces that the cookie *always wins*:
//   - server.mjs `withDashboardTokenQuery`: cookie token overrides any
//     existing ?token= / ?authToken= in the upstream WS URL.
//   - server.mjs `copyDashboardWebSocketHeaders`: cookie token overrides
//     any browser-supplied Authorization header on the upstream WS.
//   - shared.ts proxyOpenClawDashboard: on HTTP 401/403 from upstream
//     for a GET/HEAD, re-probe the live sandbox and refresh the cookie
//     before retrying.
//
// If any of these guards are reverted to "only set if not already
// present", delete-and-recreate-with-same-name silently breaks again
// for any browser with cached state. Those failure modes are invisible
// to curl-from-VPS testing — they only surface in real browsers — so
// this is the cheapest mechanical guard we can put in place.

const root = process.cwd()
const serverPath = path.join(root, 'server.mjs')
const sharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')

const serverSource = await readFile(serverPath, 'utf8')
const sharedSource = await readFile(sharedPath, 'utf8')

// ── 1. server.mjs withDashboardTokenQuery: cookie wins over URL ?token= ──

const withTokenQueryBody = serverSource.match(
  /function withDashboardTokenQuery\([^)]*\)\s*\{[\s\S]*?\n\}/
)
assert.ok(
  withTokenQueryBody,
  'server.mjs must define a withDashboardTokenQuery function'
)

const withTokenQuerySrc = withTokenQueryBody[0]

assert.match(
  withTokenQuerySrc,
  /url\.searchParams\.set\(\s*['"]token['"]\s*,\s*token\s*\)/,
  'withDashboardTokenQuery must call searchParams.set("token", token) to OVERWRITE the upstream URL token with the cookie value'
)

assert.doesNotMatch(
  withTokenQuerySrc,
  /!\s*url\.searchParams\.has\(\s*['"]token['"]\s*\)/,
  'withDashboardTokenQuery must NOT guard the cookie token with !searchParams.has("token") — that lets a stale client-supplied ?token= win. See CLAUDE.md §11 / commit 48bbfa5.'
)

assert.doesNotMatch(
  withTokenQuerySrc,
  /!\s*url\.searchParams\.has\(\s*['"]authToken['"]\s*\)/,
  'withDashboardTokenQuery must NOT guard with !searchParams.has("authToken") either — the SPA may use either query name and the cookie must override both.'
)

assert.match(
  withTokenQuerySrc,
  /url\.searchParams\.delete\(\s*['"]authToken['"]\s*\)/,
  'withDashboardTokenQuery must delete any inbound ?authToken= so a stale alias cannot win after we set ?token='
)

// ── 2. server.mjs copyDashboardWebSocketHeaders: cookie wins over Authorization ──

const copyHeadersBody = serverSource.match(
  /function copyDashboardWebSocketHeaders\([^)]*\)\s*\{[\s\S]*?\n\}/
)
assert.ok(
  copyHeadersBody,
  'server.mjs must define a copyDashboardWebSocketHeaders function'
)

const copyHeadersSrc = copyHeadersBody[0]

assert.match(
  copyHeadersSrc,
  /headers\.authorization\s*=\s*`Bearer \$\{dashboardToken\}`/,
  'copyDashboardWebSocketHeaders must set headers.authorization = `Bearer ${dashboardToken}` from the cookie'
)

assert.doesNotMatch(
  copyHeadersSrc,
  /&&\s*!headers\.authorization/,
  'copyDashboardWebSocketHeaders must NOT guard the cookie-derived Authorization with !headers.authorization — that lets a stale browser-supplied Authorization win. See CLAUDE.md §11 / commit a2e8ddb.'
)

// Also guard the raw-WS-upgrade path that builds Authorization from a list.
// buildRawDashboardUpgradeHeaders is the alternative entry point used by
// tunnelDashboardUpgrade; it must apply the same cookie-wins logic.
const rawUpgradeBody = serverSource.match(
  /function buildRawDashboardUpgradeHeaders\([^)]*\)\s*\{[\s\S]*?\n\}/
)
assert.ok(
  rawUpgradeBody,
  'server.mjs must define a buildRawDashboardUpgradeHeaders function for raw WS upgrades'
)

assert.match(
  rawUpgradeBody[0],
  /headers\.push\(\s*`Authorization: Bearer \$\{dashboardToken\}`\s*\)/,
  'buildRawDashboardUpgradeHeaders must push `Authorization: Bearer ${dashboardToken}` from the cookie'
)

// ── 3. shared.ts: HTTP 401/403 auto-refresh with re-probe + cookie refresh ──

assert.match(
  sharedSource,
  /import\s*\{[^}]*probeOpenClawDashboard[^}]*\}\s*from\s*['"]@\/app\/lib\/openshellHost['"]/,
  'shared.ts must import probeOpenClawDashboard to re-fetch the live token on 401'
)

assert.match(
  sharedSource,
  /import\s*\{[\s\S]*?(extractOpenClawDashboardToken|setOpenClawDashboardTokenCookie)[\s\S]*?\}\s*from\s*['"]@\/app\/lib\/openclawDashboardToken['"]/,
  'shared.ts must import extractOpenClawDashboardToken and setOpenClawDashboardTokenCookie for the refresh path'
)

assert.match(
  sharedSource,
  /upstream\.status\s*===\s*401\s*\|\|\s*upstream\.status\s*===\s*403/,
  'shared.ts proxy must trigger refresh on HTTP 401 OR 403 from upstream'
)

assert.match(
  sharedSource,
  /probeOpenClawDashboard\(\s*resolution\.instanceId\s*\)/,
  'shared.ts proxy must call probeOpenClawDashboard on 401/403 to fetch the live sandbox token'
)

assert.match(
  sharedSource,
  /extractOpenClawDashboardToken\(\s*probe\.bootstrapUrl\s*\)/,
  'shared.ts proxy must extract the fresh token from the probe.bootstrapUrl'
)

assert.match(
  sharedSource,
  /setOpenClawDashboardTokenCookie\(/,
  'shared.ts proxy must call setOpenClawDashboardTokenCookie to refresh the cookie when the retry succeeds'
)

// The retry must use the freshly-probed token, not the stale cookie that just got rejected.
assert.match(
  sharedSource,
  /copyRequestHeaders\(\s*request\s*,\s*target\s*,\s*controlUiOrigin\s*,\s*candidate\s*\)/,
  'shared.ts proxy must pass the freshly-probed candidate token as the override to copyRequestHeaders on retry'
)

// Body must be sendable on retry — limit refresh to non-body methods (GET/HEAD)
// because POST bodies are streams and can't be replayed.
assert.match(
  sharedSource,
  /!shouldSendBody/,
  'shared.ts proxy must only retry when !shouldSendBody (POST/PUT bodies are streams and cannot be replayed)'
)

// ── 4. tokenOverride threading in shared.ts copyRequestHeaders ──
// The signature must accept an explicit token override; otherwise the retry
// would still read the (stale) cookie from req.headers.

const copyReqBody = sharedSource.match(
  /function copyRequestHeaders\([\s\S]*?\n\)\s*\{[\s\S]*?(?=\nfunction\s|\nasync function\s|\nexport\s|\Z)/
)
assert.ok(
  copyReqBody,
  'shared.ts must define copyRequestHeaders'
)

assert.match(
  copyReqBody[0],
  /tokenOverride\?:\s*string\s*\|\s*null/,
  'copyRequestHeaders must accept a tokenOverride parameter so the 401 retry can pass the freshly-probed token instead of re-reading the stale cookie'
)

assert.match(
  copyReqBody[0],
  /tokenOverride\s*!==\s*undefined\s*\?\s*tokenOverride/,
  'copyRequestHeaders must prefer tokenOverride when defined (explicit override beats cookie)'
)

console.log('dashboard-token-cookie-wins-check: PASS dashboard token fix-chain invariants intact')
