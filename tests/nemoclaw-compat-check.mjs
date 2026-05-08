import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const helperPath = path.join(root, 'app/lib/nemoclawCli.ts')
const healthRoutePath = path.join(root, 'app/api/sandbox/[sandboxId]/health/route.ts')
const restartRoutePath = path.join(root, 'app/api/sandbox/[sandboxId]/restart/route.ts')

const [helperSource, healthRouteSource, restartRouteSource] = await Promise.all([
  readFile(helperPath, 'utf8'),
  readFile(healthRoutePath, 'utf8'),
  readFile(restartRoutePath, 'utf8'),
])

assert.match(helperSource, /const NEMOCLAW_RECOVERY_MIN_VERSION = "0\.0\.37"/, 'NemoClaw doctor/recover integration must be gated behind the v0.0.37 CLI surface')
assert.match(helperSource, /NEMOCLAW_BIN, NODE_BIN, commandExists, hostCommandEnv/, 'NemoClaw helper must use the shared host command resolver')
assert.match(helperSource, /parseVersion/, 'NemoClaw helper must parse CLI versions instead of assuming latest behavior')
assert.match(helperSource, /versionGte/, 'NemoClaw helper must compare semantic versions before using newer commands')
assert.match(helperSource, /export async function getNemoClawDoctorReport/, 'NemoClaw helper must expose a doctor JSON probe')
assert.match(helperSource, /\[sandboxName, "doctor", "--json"\]/, 'doctor probe must use the structured NemoClaw doctor JSON command')
assert.match(helperSource, /export async function recoverSandboxWithNemoClaw/, 'NemoClaw helper must expose sandbox recovery')
assert.match(helperSource, /\[sandboxName, "recover"\]/, 'sandbox recovery must use the new NemoClaw recover command')
assert.match(helperSource, /supported: false,[\s\S]*attempted: false/, 'unsupported old NemoClaw versions must skip newer commands without failing')

assert.match(healthRouteSource, /getNemoClawDoctorReport/, 'sandbox health must include NemoClaw doctor integration when available')
assert.match(healthRouteSource, /key: "nemoclaw-doctor"/, 'sandbox health must surface NemoClaw doctor as a health check')
assert.match(healthRouteSource, /Using OpenShell compatibility checks/, 'sandbox health must explicitly fall back for current NemoClaw versions')
assert.match(healthRouteSource, /minimumVersion/, 'sandbox health response must expose the minimum version for doctor support')

assert.match(restartRouteSource, /recoverSandboxWithNemoClaw/, 'sandbox restart must try NemoClaw recover when supported')
assert.ok(
  restartRouteSource.indexOf('recoverSandboxWithNemoClaw(sandboxName)') < restartRouteSource.indexOf('runSandboxShell(sandboxName, restartOpenClawGatewayScript()'),
  'sandbox restart must try NemoClaw recover before the legacy OpenClaw runtime restart fallback',
)
assert.match(restartRouteSource, /restartMode: "nemoclaw-recover"/, 'restart route must report when the new NemoClaw recovery path succeeds')
assert.match(restartRouteSource, /restartMode: "openclaw-runtime"/, 'restart route must retain the current OpenShell/OpenClaw runtime fallback')
assert.match(restartRouteSource, /NemoClaw recover did not complete[\s\S]*fell back/, 'restart route must report fallback when modern recovery is attempted but fails')

console.log('nemoclaw-compat-check: PASS NemoClaw old/new compatibility assertions')
