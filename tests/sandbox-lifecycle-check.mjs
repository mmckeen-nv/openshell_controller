import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const createRoutePath = path.join(root, 'app/api/sandbox/create/route.ts')
const deleteRoutePath = path.join(root, 'app/api/sandbox/delete/route.ts')
const hookPath = path.join(root, 'app/hooks/useSandboxInventory.ts')
const pagePath = path.join(root, 'app/page.tsx')
const configPanelPath = path.join(root, 'app/components/ConfigurationPanel.tsx')

const createRouteSource = await readFile(createRoutePath, 'utf8')
const deleteRouteSource = await readFile(deleteRoutePath, 'utf8')
const hookSource = await readFile(hookPath, 'utf8')
const pageSource = await readFile(pagePath, 'utf8')
const configPanelSource = await readFile(configPanelPath, 'utf8')

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
