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
  mcpBrokerUrlSource,
  mcpBrokerClientSource,
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
  readFile(path.join(root, 'app/lib/mcpBrokerUrl.ts'), 'utf8'),
  readFile(path.join(root, 'app/lib/mcpBrokerClient.ts'), 'utf8'),
])

assert.match(installSource, /find_nemoclaw_bin\(\)/, 'installer must discover NemoClaw CLI')
assert.match(installSource, /find_nemoclaw_setup\(\)/, 'installer may discover the legacy NemoClaw setup workflow')
assert.match(installSource, /\$HOME\/nemoclaw\/scripts\/setup\.sh/, 'installer must check common lowercase ~/nemoclaw setup path')
assert.match(installSource, /candidate="\$root\/scripts\/setup\.sh"/, 'installer must scan user home project directories for setup.sh')
assert.match(installSource, /candidate="\$nested\/scripts\/setup\.sh"/, 'installer must scan one nested user-home level for setup.sh')
assert.match(installSource, /set_env "NEMOCLAW_SETUP"/, 'installer must persist discovered NemoClaw setup path')
assert.match(installSource, /set_env "NEMOCLAW_BIN"/, 'installer must persist discovered NemoClaw CLI path')
assert.match(installSource, /set_env "OPENSHELL_HOME"/, 'installer must persist the OpenShell config home')
assert.match(installSource, /set_env "OPENSHELL_BIN"/, 'installer must persist discovered OpenShell path')
assert.match(installSource, /upsert_env "TERMINAL_SERVER_AUTOSTART" "true"/, 'installer must enable terminal bridge autostart by default')
assert.match(installSource, /ensure_npx\(\)/, 'installer must install or verify npx for stdio MCP servers')
assert.match(installSource, /ensure_uvx\(\)/, 'installer must install or verify uvx for stdio MCP servers')
assert.match(installSource, /ensure_project_venv\(\)/, 'installer must create or reuse a Python virtual environment for uvx')
assert.match(installSource, /prepend_virtualenv_bin\(\)/, 'installer must prefer an active virtual environment for uvx')
assert.match(installSource, /python3 -m venv "\$PROJECT_VENV"/, 'installer must create a project virtual environment when none is active')
assert.match(installSource, /\$venv_python" -m pip install --upgrade uv/, 'installer must install uvx into the virtual environment')
assert.match(installSource, /set_env "OPENSHELL_CONTROL_VENV"/, 'installer must persist the virtual environment path for runtime MCP launches')

assert.match(hostCommandsSource, /export const HOST_PATH/, 'host command resolution must centralize PATH construction')
assert.match(hostCommandsSource, /OPENSHELL_CONTROL_VENV/, 'host command resolution must include the installer-managed virtual environment')
assert.match(hostCommandsSource, /\.venv\/bin/, 'host command resolution must include the default project virtual environment')
assert.match(hostCommandsSource, /\.nemoclaw\/source\/bin\/nemoclaw\.js/, 'host command resolution must support standard ~/.nemoclaw installs')
assert.match(hostCommandsSource, /\.nemoclaw\/source\/scripts\/setup\.sh/, 'host command resolution must support legacy ~/.nemoclaw setup workflows')
assert.match(hostCommandsSource, /discoverHomeFiles\("scripts\/setup\.sh"\)/, 'runtime command resolution must scan user home directories for setup.sh')
assert.match(hostCommandsSource, /discoverHomeFiles\("bin\/nemoclaw\.js"\)/, 'runtime command resolution must scan user home directories for nemoclaw.js')
assert.match(hostCommandsSource, /export const NEMOCLAW_SETUP_CANDIDATES/, 'runtime command resolution must expose searched setup candidates')
assert.doesNotMatch(hostCommandsSource, /\/Users\/markmckeen|\/home\/nvidia/, 'host command resolution must not bake in developer machine paths')
assert.match(mcpBrokerUrlSource, /discoverOpenShellDockerGateway/, 'MCP broker URL generation must discover the active OpenShell Docker gateway')
assert.match(mcpBrokerUrlSource, /OPEN_SHELL_CONTAINER/, 'MCP broker URL generation must respect the configured cluster container')
assert.match(mcpBrokerUrlSource, /host\.docker\.internal/, 'MCP broker URL generation must keep a fallback for hosts without Docker inspect')
assert.match(mcpBrokerUrlSource, /discoverSandboxProxyOrigin/, 'MCP broker URL generation must discover each sandbox proxy endpoint')
assert.match(mcpBrokerUrlSource, /HTTP_PROXY/, 'MCP broker URL generation must use the sandbox proxy environment when available')
assert.match(mcpBrokerClientSource, /PATH: HOST_PATH/, 'MCP stdio broker launches must inherit the shared host PATH')

assert.match(createRouteSource, /buildNemoClawCreateCommand\(\)/, 'NemoClaw blueprint create must resolve a current CLI command')
assert.match(createRouteSource, /"onboard", "--non-interactive"/, 'NemoClaw blueprint create must use the supported onboard CLI flow')
assert.match(createRouteSource, /NEMOCLAW_SANDBOX_NAME: sandboxName/, 'NemoClaw blueprint create must pass the requested sandbox name to onboard')
assert.match(createRouteSource, /NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1"/, 'NemoClaw blueprint create must be able to run onboard non-interactively')
assert.match(createRouteSource, /mode: "legacy-setup"/, 'NemoClaw blueprint create may fall back to legacy setup.sh for old clones')
assert.match(createRouteSource, /NemoClaw CLI was not found/, 'missing current CLI must produce an actionable error')
assert.match(createRouteSource, /NEMOCLAW_BIN_CANDIDATES\.join/, 'missing current CLI error must list searched candidates')
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
