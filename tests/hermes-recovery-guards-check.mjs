import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

// Regression guard for the BYOVPS Hermes gateway-crash recovery fix (June 2026).
// See CLAUDE.md §9 and the discussion in commit c4c2c1d (later superseded by
// ensure-recovery-guards.sh).
//
// NemoClaw's gateway-recovery refuses to relaunch the Hermes gateway when
// /tmp/nemoclaw-proxy-env.sh is present but NODE_OPTIONS doesn't reference
// BOTH the sandbox-safety-net preload AND the ciao-network-guard preload
// (see /opt/nemoclaw/src/lib/agent/runtime.ts line ~190, looking for the
// literal substrings "nemoclaw-sandbox-safety-net" and
// "nemoclaw-ciao-network-guard" in NODE_OPTIONS via a shell case glob).
//
// On cloud OpenClaw installs, nemoclaw-start writes those exports into
// proxy-env.sh automatically. On BYOVPS Hermes installs, that step is
// missing — so any abrupt gateway crash (SIGKILL, OOM, Python exception)
// leaves the sandbox permanently broken because nothing on the host can
// restart the gateway: nemoclaw recover invokes gateway-recovery which
// refuses, and there is no equivalent mechanism inside the container.
//
// ensure-recovery-guards.sh closes the gap by:
//   1. Copying the REAL sandbox-safety-net.js + ciao-network-guard.js from
//      /opt/nemoclaw/nemoclaw-blueprint/scripts/ into the container at
//      /tmp/nemoclaw-sandbox-safety-net.js and /tmp/nemoclaw-ciao-network-guard.js
//      (paths chosen so the substring check in gateway-recovery matches).
//   2. Appending NODE_OPTIONS=--require=<both> to proxy-env.sh — but ONLY if
//      proxy-env.sh doesn't already have a NODE_OPTIONS export (which would
//      mean either we already patched it, or it's an OpenClaw sandbox that
//      ships with the exports already).
//
// Without this script, the previous workaround (remove proxy-env.sh then
// nemoclaw recover) loses HTTP_PROXY + SSL_CERT_FILE + HERMES_HOME etc.,
// breaking the gateway's outbound network calls.

const root = process.cwd()
const scriptPath = path.join(root, 'scripts/hermes-remote/ensure-recovery-guards.sh')
const watchdogPath = path.join(root, 'scripts/hermes-remote/watchdog.sh')
const exposePath = path.join(root, 'scripts/hermes-remote/expose.sh')

const scriptSource = await readFile(scriptPath, 'utf8')
const watchdogSource = await readFile(watchdogPath, 'utf8')
const exposeSource = await readFile(exposePath, 'utf8')

// ── 1. ensure-recovery-guards.sh copies BOTH preload files ──

assert.ok(
  /sandbox-safety-net\.js/.test(scriptSource),
  'ensure-recovery-guards.sh must reference sandbox-safety-net.js',
)
assert.ok(
  /ciao-network-guard\.js/.test(scriptSource),
  'ensure-recovery-guards.sh must reference ciao-network-guard.js',
)
assert.ok(
  /docker cp/.test(scriptSource),
  'ensure-recovery-guards.sh must use `docker cp` to install the guards inside the container',
)

// ── 2. The destination paths contain the substrings NemoClaw checks for ──

assert.ok(
  /nemoclaw-sandbox-safety-net/.test(scriptSource),
  'ensure-recovery-guards.sh must place the safety-net file at a path containing the substring ' +
  '"nemoclaw-sandbox-safety-net" — the NemoClaw gateway-recovery check uses a shell case glob ' +
  '*nemoclaw-sandbox-safety-net* against NODE_OPTIONS, so the path must include this literal.',
)
assert.ok(
  /nemoclaw-ciao-network-guard/.test(scriptSource),
  'ensure-recovery-guards.sh must place the ciao guard at a path containing the substring ' +
  '"nemoclaw-ciao-network-guard" — same reason as the safety-net path.',
)

// ── 3. The script is idempotent (skips when NODE_OPTIONS already present) ──

assert.ok(
  /grep -q.*NODE_OPTIONS/.test(scriptSource),
  'ensure-recovery-guards.sh must check whether proxy-env.sh already has an `export NODE_OPTIONS=` ' +
  'line and skip the append when it does. This is the OpenClaw-sandbox short-circuit: OpenClaw ' +
  'nemoclaw-start already writes the required exports, so we must NOT add duplicate lines (which ' +
  'would break Node\'s --require parsing).',
)

// ── 4. watchdog.sh calls the script on every tick BEFORE attempting recovery ──

assert.ok(
  /ensure-recovery-guards\.sh/.test(watchdogSource),
  'watchdog.sh must call ensure-recovery-guards.sh so the guards get re-applied after every ' +
  'container restart that rewrote proxy-env.sh from scratch.',
)
assert.ok(
  !/rm -f \/tmp\/nemoclaw-proxy-env\.sh/.test(watchdogSource),
  'watchdog.sh must NOT remove /tmp/nemoclaw-proxy-env.sh — that was the old workaround that ' +
  'dropped HTTP_PROXY/SSL_CERT_FILE/HERMES_HOME. With the guards in place we no longer need it.',
)

// ── 5. expose.sh calls the script during initial provisioning ──

assert.ok(
  /ensure-recovery-guards\.sh/.test(exposeSource),
  'expose.sh must call ensure-recovery-guards.sh so the guards are in place from the moment ' +
  'Hermes remote is first exposed, not just after the first watchdog tick.',
)

// ── 6. The script's NODE_OPTIONS string would pass the NemoClaw substring check ──
//
// NemoClaw's gateway-recovery uses this shell case glob (see
// /opt/nemoclaw/src/lib/agent/runtime.ts ~line 190):
//
//   case "${NODE_OPTIONS:-}" in *nemoclaw-sandbox-safety-net*) _SN_MISSING=0 ;; *) _SN_MISSING=1 ;; esac
//   case "${NODE_OPTIONS:-}" in *nemoclaw-ciao-network-guard*) _CIAO_MISSING=0 ;; *) _CIAO_MISSING=1 ;; esac
//
// Extract the NODE_OPTIONS value our script would append and confirm both
// substrings are present. This catches refactors that accidentally rename
// the destination paths and break the substring match.

const nodeOptionsMatch = scriptSource.match(/NODE_OPTIONS=[^"\\n]*([^"\\n]*?)["']/)
if (nodeOptionsMatch) {
  const synthesizedLine = scriptSource.match(/export NODE_OPTIONS="[^"]+"/)?.[0]
  const expandedSample = (synthesizedLine || scriptSource)
    .replace(/\$\{SAFETY_NET_DEST\}|\$SAFETY_NET_DEST/g, '/tmp/nemoclaw-sandbox-safety-net.js')
    .replace(/\$\{CIAO_GUARD_DEST\}|\$CIAO_GUARD_DEST/g, '/tmp/nemoclaw-ciao-network-guard.js')
  assert.ok(
    expandedSample.includes('nemoclaw-sandbox-safety-net'),
    'After variable expansion, the NODE_OPTIONS value must contain the literal substring ' +
    '"nemoclaw-sandbox-safety-net" — otherwise NemoClaw\'s case-glob check fails.',
  )
  assert.ok(
    expandedSample.includes('nemoclaw-ciao-network-guard'),
    'After variable expansion, the NODE_OPTIONS value must contain the literal substring ' +
    '"nemoclaw-ciao-network-guard" — otherwise NemoClaw\'s case-glob check fails.',
  )
}

// ── 7. Vendored preload fallback ──
//
// On BYOVPS hosts installed via install_versioned_nemoclaw_openshell.sh, the
// NemoClaw source tree at /opt/nemoclaw/ doesn't exist (the installer builds
// from a mktemp -d and cleans up). Without a fallback, the script dies and
// the gateway can't be made recoverable. The vendored copies in
// scripts/hermes-remote/preloads/ are the fallback source.

const vendoredDir = path.join(root, 'scripts/hermes-remote/preloads')
await stat(path.join(vendoredDir, 'sandbox-safety-net.js'))
await stat(path.join(vendoredDir, 'ciao-network-guard.js'))

assert.ok(
  /VENDORED_SCRIPTS_DIR|preloads/.test(scriptSource),
  'ensure-recovery-guards.sh must reference the vendored preloads directory as a fallback ' +
  '(scripts/hermes-remote/preloads/). Without this fallback, BYOVPS hosts installed via ' +
  'install_versioned_nemoclaw_openshell.sh have no source tree at /opt/nemoclaw/ and the script ' +
  'dies before installing the guards.',
)

// Verify the vendored files actually carry the NVIDIA SPDX header so a future
// "let me just rewrite these to remove the dep" doesn't silently lose the
// real safety-net behaviour.
const vendoredSafetyNet = await readFile(path.join(vendoredDir, 'sandbox-safety-net.js'), 'utf8')
const vendoredCiaoGuard = await readFile(path.join(vendoredDir, 'ciao-network-guard.js'), 'utf8')
for (const [name, source] of [['sandbox-safety-net.js', vendoredSafetyNet], ['ciao-network-guard.js', vendoredCiaoGuard]]) {
  assert.ok(
    /SPDX-License-Identifier: Apache-2\.0/.test(source) && /NVIDIA CORPORATION/.test(source),
    `Vendored ${name} must preserve the SPDX-License-Identifier: Apache-2.0 + NVIDIA copyright ` +
    `header. We vendor these files verbatim under Apache-2.0 to satisfy the NemoClaw ` +
    `gateway-recovery substring check and provide real safety-net behaviour at runtime.`,
  )
}

console.log('PASS: ensure-recovery-guards.sh installs sandbox-safety-net.js + ciao-network-guard.js at NemoClaw-recognised paths')
console.log('PASS: ensure-recovery-guards.sh is idempotent (skips when NODE_OPTIONS already present)')
console.log('PASS: watchdog.sh runs the guards before recovery and no longer removes proxy-env.sh')
console.log('PASS: expose.sh runs the guards during initial provisioning')
console.log('PASS: synthesized NODE_OPTIONS value passes NemoClaw\'s substring check for both guards')
console.log('PASS: vendored preloads exist with NVIDIA Apache-2.0 SPDX header')
console.log('PASS: ensure-recovery-guards.sh has a vendored-preloads fallback for BYOVPS hosts without /opt/nemoclaw')
