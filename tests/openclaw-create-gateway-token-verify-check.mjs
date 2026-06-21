import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Regression guard for the BYOVPS "Auth did not match" fix (June 2026).
// See CLAUDE.md §11 — "OpenClaw dashboard token + tunnel architecture".
//
// On BYOVPS, `openclaw doctor --generate-gateway-token` writes a new token
// to /sandbox/.openclaw/openclaw.json AND triggers a gateway restart. The
// gateway-recovery fork sometimes fails to complete the restart (see
// #2478 NODE_OPTIONS guard), leaving the JSON with the new token while the
// live gateway is still using the previous token (or no token at all).
//
// Without verification, the first dashboard open after sandbox creation
// reads the new JSON token, sets it as the cookie, opens the browser tab,
// and the WS handshake hits a gateway that rejects it → "Auth did not
// match — gateway token mismatch" in the UI.
//
// The fix in ensureOpenClawGatewayToken polls the gateway WS handshake
// up to 10 times over ~15 s after running doctor, only returning after
// the gateway has actually accepted the new JSON token. The result
// includes `gatewayAccepted: boolean` so callers can detect the failure
// mode and decide whether to surface a warning.
//
// If this verification is removed, the dashboard race re-introduces
// itself for every fresh sandbox creation on BYOVPS.

const root = process.cwd()
const createRoutePath = path.join(root, 'app/api/sandbox/create/route.ts')
const createRouteSource = await readFile(createRoutePath, 'utf8')

// ── 1. ensureOpenClawGatewayToken verifies the token vs the live gateway ──

const ensureBody = createRouteSource.match(
  /async function ensureOpenClawGatewayToken[\s\S]+?\n\}\n/,
)
assert.ok(
  ensureBody,
  'expected ensureOpenClawGatewayToken function in app/api/sandbox/create/route.ts',
)

assert.ok(
  /Sec-WebSocket-Key|Upgrade: websocket/i.test(ensureBody[0]),
  'ensureOpenClawGatewayToken must perform a WS handshake to verify token acceptance ' +
  '(BYOVPS #2478): the WS handshake against the in-sandbox gateway is the only way to ' +
  'confirm the JSON token matches what the live gateway is using.',
)

assert.ok(
  /gw_accepted|gatewayAccepted/.test(ensureBody[0]),
  'ensureOpenClawGatewayToken must expose a gatewayAccepted flag so callers can detect ' +
  'when the JSON token was written but the gateway has not yet picked it up.',
)

assert.ok(
  /for [\s\S]{0,40}seq 1 1\d|for [\s\S]{0,40}_i in/.test(ensureBody[0]),
  'ensureOpenClawGatewayToken must POLL the gateway repeatedly (not a single attempt) — ' +
  'the gateway restart takes 5–15 s after doctor on BYOVPS.',
)

assert.ok(
  /sleep [0-9]/.test(ensureBody[0]),
  'ensureOpenClawGatewayToken poll loop must sleep between attempts.',
)

// ── 2. The result type includes gatewayAccepted at all three call sites ──

const catchHandlers = createRouteSource.match(/ensureOpenClawGatewayToken\(sandboxName\)\.catch\(\(error\) => \(\{[\s\S]+?\}\)\)/g)
assert.ok(
  catchHandlers && catchHandlers.length >= 1,
  'expected at least one ensureOpenClawGatewayToken catch handler with inline shape',
)
for (const handler of catchHandlers) {
  assert.ok(
    /gatewayAccepted: false/.test(handler),
    'ensureOpenClawGatewayToken catch handler must include `gatewayAccepted: false` to keep ' +
    'the result shape consistent. Otherwise downstream consumers that read .gatewayAccepted ' +
    `silently get undefined. Offending block:\n${handler}`,
  )
}

console.log('PASS: ensureOpenClawGatewayToken verifies the JSON token against the live gateway')
console.log('PASS: gatewayAccepted flag is exposed and present in all catch shapes')
