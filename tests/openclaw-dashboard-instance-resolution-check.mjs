import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const instancesPath = path.join(root, 'app/lib/openclawInstances.ts')
const routePath = path.join(root, 'app/api/openshell/dashboard/open/route.ts')
const sandboxListPath = path.join(root, 'app/components/SandboxList.tsx')

const instancesSource = await readFile(instancesPath, 'utf8')
assert.match(
  instancesSource,
  /MY_ASSISTANT_OPENCLAW_INSTANCE_ID/,
  'openclaw instance registry should expose a dedicated my-assistant env mapping seam'
)
assert.match(
  instancesSource,
  /OPENCLAW_SANDBOX_INSTANCE_MAP_JSON/,
  'openclaw instance registry should allow additive sandbox->instance JSON mappings'
)
assert.match(
  instancesSource,
  /export function resolveOpenClawInstanceForSandbox\(sandboxId\?: string \| null\)/,
  'openclaw instance registry should expose sandbox-aware instance resolution'
)
assert.match(
  instancesSource,
  /getOpenClawInstanceIdForSandbox\(sandboxId\?: string \| null\)/,
  'openclaw instance registry should expose sandbox mapping lookup'
)

const routeSource = await readFile(routePath, 'utf8')
assert.match(
  routeSource,
  /const sandboxId = requestUrl\.searchParams\.get\('sandboxId'\)/,
  'dashboard open route must accept sandboxId'
)
assert.match(
  routeSource,
  /resolveOpenClawInstanceForSandbox\(sandboxId\)/,
  'dashboard open route must resolve instances from sandbox context when instanceId is absent'
)
assert.match(
  routeSource,
  /sandboxInstanceId: mappedSandboxInstanceId/,
  'dashboard open route response should expose mapped sandbox instance metadata'
)
assert.match(
  routeSource,
  /sandboxId,\s*\n\s*sandboxInstanceId: mappedSandboxInstanceId,\s*\n\s*instanceId: instance\.id/,
  'dashboard open route response should include sandboxId alongside resolved instance metadata'
)
assert.match(
  routeSource,
  /bootstrapUrl: probe\.bootstrapUrl/,
  'dashboard open route should return explicit bootstrap URL metadata'
)
assert.match(
  routeSource,
  /bootstrapTokenPresent: probe\.bootstrapTokenPresent/,
  'dashboard open route should expose whether the bootstrap contract is tokenized'
)

const sandboxListSource = await readFile(sandboxListPath, 'utf8')
assert.match(
  sandboxListSource,
  /searchParams\.set\('sandboxId', selectedSandbox\.id\)/,
  'sandbox list must pass selected sandboxId when opening the dashboard'
)
assert.match(
  sandboxListSource,
  /fetch\(`\/api\/openshell\/dashboard\/open\?\$\{searchParams\.toString\(\)\}`\)/,
  'sandbox list should call the sandbox-aware dashboard open route'
)
assert.match(
  sandboxListSource,
  /OpenClaw dashboard opened in a new tab/,
  'sandbox list should surface concise dashboard launch feedback'
)

console.log('openclaw-dashboard-instance-resolution-check: PASS sandbox-aware dashboard resolution assertions')
