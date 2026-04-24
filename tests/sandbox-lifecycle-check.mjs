import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const createRoutePath = path.join(root, 'app/api/sandbox/create/route.ts')
const deleteRoutePath = path.join(root, 'app/api/sandbox/delete/route.ts')
const telemetryRoutePath = path.join(root, 'app/api/telemetry/real/route.ts')
const inferenceRoutePath = path.join(root, 'app/api/inference/route.ts')
const ollamaModelsRoutePath = path.join(root, 'app/api/ollama/models/route.ts')
const sandboxInferenceRoutePath = path.join(root, 'app/api/sandbox/[sandboxId]/inference/route.ts')
const sandboxInferenceApplyRoutePath = path.join(root, 'app/api/sandbox/[sandboxId]/inference/apply/route.ts')
const sandboxRestartRoutePath = path.join(root, 'app/api/sandbox/[sandboxId]/restart/route.ts')
const hookPath = path.join(root, 'app/hooks/useSandboxInventory.ts')
const pagePath = path.join(root, 'app/page.tsx')
const configPanelPath = path.join(root, 'app/components/ConfigurationPanel.tsx')
const inferencePanelPath = path.join(root, 'app/components/InferenceEndpointPanel.tsx')
const sandboxInferencePanelPath = path.join(root, 'app/components/SandboxInferencePanel.tsx')
const sidebarPath = path.join(root, 'app/components/Sidebar.tsx')
const sandboxListPath = path.join(root, 'app/components/SandboxList.tsx')

const createRouteSource = await readFile(createRoutePath, 'utf8')
const deleteRouteSource = await readFile(deleteRoutePath, 'utf8')
const telemetryRouteSource = await readFile(telemetryRoutePath, 'utf8')
const inferenceRouteSource = await readFile(inferenceRoutePath, 'utf8')
const ollamaModelsRouteSource = await readFile(ollamaModelsRoutePath, 'utf8')
const sandboxInferenceRouteSource = await readFile(sandboxInferenceRoutePath, 'utf8')
const sandboxInferenceApplyRouteSource = await readFile(sandboxInferenceApplyRoutePath, 'utf8')
const sandboxRestartRouteSource = await readFile(sandboxRestartRoutePath, 'utf8')
const hookSource = await readFile(hookPath, 'utf8')
const pageSource = await readFile(pagePath, 'utf8')
const configPanelSource = await readFile(configPanelPath, 'utf8')
const inferencePanelSource = await readFile(inferencePanelPath, 'utf8')
const sandboxInferencePanelSource = await readFile(sandboxInferencePanelPath, 'utf8')
const sidebarSource = await readFile(sidebarPath, 'utf8')
const sandboxListSource = await readFile(sandboxListPath, 'utf8')

assert.match(
  createRouteSource,
  /const readiness = await waitForSandboxReady\(sandboxName, 90000, 2000\)/,
  'blueprint create must poll authoritative readiness before returning success',
)
assert.match(
  createRouteSource,
  /readiness:\s*\{\s*attempts: readiness\.attempts,\s*elapsedMs: readiness\.elapsedMs,/,
  'blueprint create response must expose readiness polling metadata',
)

assert.match(hookSource, /type RefreshOptions = \{\s*force\?: boolean\s*\}/, 'inventory refresh must accept a force option')
assert.match(hookSource, /!refreshOptions\?\.force && inFlightRef\.current/, 'forced inventory refresh must bypass existing in-flight reads')
assert.match(hookSource, /requestIdRef = useRef\(0\)/, 'inventory refresh must guard against stale concurrent responses')

assert.match(deleteRouteSource, /OPENSHELL_BIN.*openshell/, 'delete route must use the OpenShell CLI')
assert.match(deleteRouteSource, /\["sandbox", "delete", sandboxName\]/, 'delete route must call openshell sandbox delete with the sandbox name')
assert.match(deleteRouteSource, /validateSandboxName/, 'delete route must validate sandbox names before execution')
assert.match(deleteRouteSource, /resolveSandboxRef/, 'delete route must resolve sandbox ids to names before deleting')
assert.match(deleteRouteSource, /OPENSHELL_GATEWAY: process\.env\.OPENSHELL_GATEWAY \|\| "nemoclaw"/, 'delete route must use the NemoClaw gateway context by default')
assert.match(deleteRouteSource, /waitForSandboxDeleted/, 'delete route must poll authoritative inventory until the sandbox is gone')
assert.match(deleteRouteSource, /cleanupNemoClawSandbox/, 'delete route must clean up NemoClaw registry state after deleting from OpenShell')
assert.match(deleteRouteSource, /\[sandboxName, "destroy", "--yes"\]/, 'delete route must run the non-interactive NemoClaw destroy workflow')
assert.match(deleteRouteSource, /openShellAlreadyGone/, 'delete route must tolerate sandboxes that OpenShell already deleted while NemoClaw still has registry state')
assert.match(deleteRouteSource, /isNemoClawSandboxNotRegistered/, 'delete route must tolerate NemoClaw registry entries that were already cleaned up')
assert.match(telemetryRouteSource, /const names = parseOpenShellSandboxNames\(sandboxListStdout\)/, 'telemetry must derive inventory from OpenShell before consulting NemoClaw')
assert.match(telemetryRouteSource, /names\.length > 0[\s\S]*execNemoclaw\(\["list"\]\)[\s\S]*execNemoclaw\(\["status"\]\)/, 'telemetry must skip NemoClaw list/status when OpenShell reports zero live sandboxes')
assert.match(inferenceRouteSource, /\["provider", "create", "--name", name, "--type", type\]/, 'inference route must create OpenShell providers')
assert.match(inferenceRouteSource, /\["provider", "update", name\]/, 'inference route must update existing OpenShell providers')
assert.match(inferenceRouteSource, /\["inference", "set", "--provider", name, "--model", model\]/, 'inference route must set the active OpenShell inference route')
assert.match(inferenceRouteSource, /OPENAI_BASE_URL=\$\{baseUrl\}/, 'inference route must pass endpoint URL as provider config')
assert.match(inferencePanelSource, /INFERENCE ENDPOINTS/, 'settings UI must expose inference endpoint configuration')
assert.match(inferencePanelSource, /\/api\/ollama\/models/, 'settings UI must poll local Ollama models')
assert.match(inferencePanelSource, /window\.setInterval\(\(\) => loadOllamaModels\(\{ silent: true \}\), 10000\)/, 'settings UI must autopoll Ollama while selected')
assert.match(ollamaModelsRouteSource, /\/api\/tags/, 'Ollama models route must query the Ollama tags API')
assert.match(ollamaModelsRouteSource, /OLLAMA_BASE_URL/, 'Ollama models route must support a configurable Ollama base URL')
assert.match(sandboxInferenceRouteSource, /parseRoutes/, 'sandbox inference route must accept multiple provider/model routes')
assert.match(sandboxInferenceRouteSource, /primaryRouteId/, 'sandbox inference route must preserve the primary route selection')
assert.match(sandboxInferenceRouteSource, /saveSandboxInferenceConfig/, 'sandbox inference route must persist per-sandbox inference profiles')
assert.match(sandboxInferencePanelSource, /Save Sandbox Routes/, 'selected sandbox UI must expose multi-route inference saving')
assert.match(sandboxInferencePanelSource, /Apply to Running Container/, 'selected sandbox UI must expose live apply for running containers')
assert.match(sandboxInferencePanelSource, /\/api\/sandbox\/\$\{encodeURIComponent\(sandbox\.id\)\}\/inference/, 'selected sandbox UI must load and save sandbox-specific inference profiles')
assert.match(sandboxInferencePanelSource, /\/api\/sandbox\/\$\{encodeURIComponent\(sandbox\.id\)\}\/inference\/apply/, 'selected sandbox UI must call live apply endpoint')
assert.match(sandboxInferencePanelSource, /\/api\/ollama\/models/, 'selected sandbox UI must offer Ollama model selection')
assert.match(sandboxInferencePanelSource, /Enabled Routes/, 'selected sandbox UI must show multiple enabled inference routes')
assert.match(sandboxInferencePanelSource, /Add Route/, 'selected sandbox UI must allow adding provider/model routes')
assert.match(sandboxInferenceApplyRouteSource, /\/sandbox\/\.openclaw\/openclaw\.json/, 'live apply must patch OpenClaw config inside the running sandbox')
assert.match(sandboxInferenceApplyRouteSource, /sha256sum \/sandbox\/\.openclaw\/openclaw\.json > \/sandbox\/\.openclaw\/\.config-hash/, 'live apply must refresh the immutable OpenClaw config hash')
assert.match(sandboxInferenceApplyRouteSource, /\["inference", "set", "--no-verify", "--provider", primary\.provider, "--model", primary\.model\]/, 'live apply must point OpenShell inference at the primary route')
assert.match(sandboxRestartRouteSource, /\["delete", "pod", sandboxName, "-n", OPENSHELL_SANDBOX_NAMESPACE, "--wait=false"\]/, 'restart route must restart the backing sandbox pod')
assert.match(sandboxRestartRouteSource, /waitForSandboxReady\(sandboxName, 90000, 2000\)/, 'restart route must wait for OpenShell to report the sandbox ready')
assert.match(sandboxListSource, /Restart Sandbox/, 'sandbox details must expose a restart sandbox button')
assert.match(sandboxListSource, /\/api\/sandbox\/\$\{encodeURIComponent\(selectedSandbox\.id\)\}\/restart/, 'restart button must call the sandbox restart endpoint')
assert.match(sandboxListSource, /<SandboxInferencePanel sandbox=\{selectedSandbox\} \/>/, 'sandbox list must render the per-sandbox inference profile panel for the selected sandbox')
assert.match(sidebarSource, /Inference Endpoints/, 'sidebar settings item must be named Inference Endpoints')
assert.match(pageSource, /<InferenceEndpointPanel \/>/, 'settings view must render inference endpoint panel')

assert.match(pageSource, /fetch\('\/api\/sandbox\/delete'/, 'destroy workflow must call the real sandbox delete endpoint')
assert.match(pageSource, /refresh\(\{ force: true \}\)/, 'create and destroy workflows must force fresh inventory reads')
assert.match(pageSource, /refreshUntilSandboxVisible/, 'create workflow must wait for the new sandbox to appear in inventory')
assert.match(pageSource, /refreshUntilSandboxGone/, 'destroy workflow must wait for deleted sandboxes to leave inventory')
assert.match(
  pageSource,
  /isDestroyMode \? \([\s\S]*<SandboxList[\s\S]*isDestroyMode=\{isDestroyMode\}/,
  'destroy mode must render the sandbox list so a sandbox can be selected'
)
assert.doesNotMatch(pageSource, /console\.log\('Destroying sandbox:'/, 'destroy workflow must not be a UI-only placeholder')
assert.doesNotMatch(configPanelSource, /onInventoryRefresh/, 'create panel must leave post-create inventory orchestration to the parent')

console.log('sandbox-lifecycle-check: PASS create/destroy lifecycle assertions')
