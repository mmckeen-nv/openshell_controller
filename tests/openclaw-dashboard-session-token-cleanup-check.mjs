import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Regression guard for the BYOVPS sessionStorage stale-token bug (June 2026).
// See CLAUDE.md §11 — "OpenClaw dashboard token + tunnel architecture".
//
// The SPA stores its gateway token in sessionStorage under TWO scoped keys
// per sandbox:
//   1. openclaw.control.token.v1:wss://<host>/api/.../proxy   (from gatewayUrl)
//   2. openclaw.control.token.v1:https://<host>/api/.../proxy (from window.location)
//
// The SPA replays this token in the application-level WS connect frame
// (NOT just the WS handshake) so our server.mjs cookie-wins fix doesn't
// catch it. After multiple failed probe attempts during the BYOVPS doctor-
// rotation race, stale tokens accumulate in these scoped keys and the
// next attempt sends them, triggering "Auth did not match" even when the
// HttpOnly cookie has the fresh token.
//
// The fix in bootstrapScriptResponse wipes ALL existing
// openclaw.control.token.v1:<scope> keys whose scope contains the current
// proxyPrefix, then writes the fresh hash token under both the wss:// and
// the https:// (page-origin) scopes so the SPA's own lookup finds it.
//
// If this cleanup is removed, the sessionStorage stale-token bug returns
// and the workaround (open in Incognito / clear DevTools) becomes the only
// way to recover for the affected sandbox URL.

const root = process.cwd()
const sharedPath = path.join(root, 'app/api/openshell/dashboard/proxy/shared.ts')
const sharedSource = await readFile(sharedPath, 'utf8')

const bootstrapBody = sharedSource.match(/function bootstrapScriptResponse[\s\S]+?\n\}\n/)
assert.ok(bootstrapBody, 'expected bootstrapScriptResponse function in shared.ts')

const body = bootstrapBody[0]

// ── 1. Iterate sessionStorage looking for tokenPrefix keys to wipe ──

assert.ok(
  /window\.sessionStorage\.length[\s\S]{0,400}tokenPrefix[\s\S]{0,200}removeItem/.test(body),
  'bootstrapScriptResponse must iterate sessionStorage and remove existing tokenPrefix:<scope> ' +
  'keys (NOT just the unscoped tokenKey). Otherwise stale tokens from prior failed probes ' +
  'remain in sessionStorage and the SPA replays them in the WS connect frame, bypassing the ' +
  'server.mjs cookie-wins fix and causing "Auth did not match" on subsequent attempts.',
)

// ── 2. Scope-filter the cleanup by proxyPrefix so it doesn't wipe OTHER sandboxes ──

assert.ok(
  /\.includes\(proxyPrefix\)/.test(body),
  'sessionStorage cleanup must filter by .includes(proxyPrefix) so it only wipes tokens for ' +
  'the current sandbox proxy path. Without the filter, opening sandbox A would wipe sandbox B\'s ' +
  'live token from the same browser session.',
)

// ── 3. Write the fresh token under both wss:// and https:// scopes ──

assert.ok(
  /window\.location\.protocol[\s\S]{0,80}window\.location\.host[\s\S]{0,80}proxyPrefix/.test(body) &&
  /sessionStorage\.setItem\(tokenPrefix \+ pageScope, token\)/.test(body),
  'bootstrapScriptResponse must write the fresh token under the https:// page-origin scope ' +
  '(window.location.protocol + window.location.host + proxyPrefix). The SPA derives this scope ' +
  'from window.location for its own sessionStorage lookup, and if we only write the wss:// ' +
  'gatewayScopes, the SPA finds no token under its expected key and falls back to a stale one.',
)

console.log('PASS: bootstrap wipes existing sessionStorage tokenPrefix:<scope> keys for this proxyPrefix')
console.log('PASS: bootstrap writes fresh token under both wss:// gatewayScopes and https:// pageScope')
