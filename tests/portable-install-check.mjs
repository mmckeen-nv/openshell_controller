import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

const [
  installSource,
  hostCommandsSource,
  createRouteSource,
  deleteRouteSource,
  telemetrySource,
  openshellHostSource,
  sandboxFilesSource,
  sandboxPermissionsSource,
  inferenceSource,
  supportBundleSource,
] = await Promise.all([
  readFile(path.join(root, 'install.sh'), 'utf8'),
  readFile(path.join(root, 'app/lib/hostCommands.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/sandbox/create/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/sandbox/delete/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/telemetry/real/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/lib/openshellHost.ts'), 'utf8'),
  readFile(path.join(root, 'app/lib/sandboxFiles.ts'), 'utf8'),
  readFile(path.join(root, 'app/lib/sandboxPermissions.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/inference/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/support-bundle/route.ts'), 'utf8'),
])

assert.match(installSource, /find_nemoclaw_bin\(\)/, 'installer must discover NemoClaw CLI')
assert.match(installSource, /find_nemoclaw_setup\(\)/, 'installer must discover NemoClaw setup workflow')
assert.match(installSource, /\$HOME\/nemoclaw\/scripts\/setup\.sh/, 'installer must check common lowercase ~/nemoclaw setup path')
assert.match(installSource, /candidate="\$root\/scripts\/setup\.sh"/, 'installer must scan user home project directories for setup.sh')
assert.match(installSource, /candidate="\$nested\/scripts\/setup\.sh"/, 'installer must scan one nested user-home level for setup.sh')
assert.match(installSource, /set_env "NEMOCLAW_SETUP"/, 'installer must persist discovered NemoClaw setup path')
assert.match(installSource, /set_env "NEMOCLAW_BIN"/, 'installer must persist discovered NemoClaw CLI path')
assert.match(installSource, /set_env "OPENSHELL_BIN"/, 'installer must persist discovered OpenShell path')
assert.match(installSource, /upsert_env "TERMINAL_SERVER_AUTOSTART" "true"/, 'installer must enable terminal bridge autostart by default')

assert.match(hostCommandsSource, /export const HOST_PATH/, 'host command resolution must centralize PATH construction')
assert.match(hostCommandsSource, /\.nemoclaw\/source\/bin\/nemoclaw\.js/, 'host command resolution must support standard ~/.nemoclaw installs')
assert.match(hostCommandsSource, /\.nemoclaw\/source\/scripts\/setup\.sh/, 'host command resolution must support standard ~/.nemoclaw setup workflow')
assert.match(hostCommandsSource, /discoverHomeFiles\("scripts\/setup\.sh"\)/, 'runtime command resolution must scan user home directories for setup.sh')
assert.match(hostCommandsSource, /discoverHomeFiles\("bin\/nemoclaw\.js"\)/, 'runtime command resolution must scan user home directories for nemoclaw.js')
assert.match(hostCommandsSource, /export const NEMOCLAW_SETUP_CANDIDATES/, 'runtime command resolution must expose searched setup candidates')
assert.doesNotMatch(hostCommandsSource, /\/Users\/markmckeen|\/home\/nvidia/, 'host command resolution must not bake in developer machine paths')

assert.match(createRouteSource, /requireNemoClawSetup\(\)/, 'NemoClaw blueprint create must validate setup workflow before running bash')
assert.match(createRouteSource, /NemoClaw blueprint setup script was not found/, 'missing setup workflow must produce an actionable error')
assert.match(createRouteSource, /Searched: \$\{NEMOCLAW_SETUP_CANDIDATES\.join/, 'missing setup workflow error must list searched candidates')
assert.match(createRouteSource, /from "@\/app\/lib\/hostCommands"/, 'create route must use shared command resolution')
assert.match(deleteRouteSource, /NEMOCLAW_CWD/, 'delete route must use resolved NemoClaw working directory')

for (const [label, source] of [
  ['telemetry', telemetrySource],
  ['openshell host', openshellHostSource],
  ['sandbox files', sandboxFilesSource],
  ['sandbox permissions', sandboxPermissionsSource],
  ['inference', inferenceSource],
  ['support bundle', supportBundleSource],
]) {
  assert.match(source, /hostCommands/, `${label} must use shared host command resolution`)
  assert.doesNotMatch(source, /\/Users\/markmckeen|\/home\/nvidia/, `${label} must not bake in developer machine paths`)
}

console.log('portable-install-check: PASS installer and host command portability assertions')
