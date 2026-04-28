import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

const [wizardSource, routeSource] = await Promise.all([
  readFile(path.join(root, 'app/components/WizardPanel.tsx'), 'utf8'),
  readFile(path.join(root, 'app/api/controller-node/plan/route.ts'), 'utf8'),
])

assert.match(wizardSource, /Spawn a Controller Node/, 'wizard must expose a controller-node workflow')
assert.match(wizardSource, /Generate Launch Kit/, 'controller workflow must generate a launch kit')
assert.match(wizardSource, /\/api\/controller-node\/plan/, 'wizard must call the controller-node plan API')
assert.match(wizardSource, /OPENCLAW_DASHBOARD_URL|OpenClaw Dashboard URL/, 'wizard must collect the remote OpenClaw upstream')
assert.match(wizardSource, /OPENSHELL_GATEWAY|OpenShell Gateway/, 'wizard must collect the remote OpenShell gateway context')
assert.match(wizardSource, /Controller Env/, 'wizard must expose the generated controller environment')
assert.match(wizardSource, /Readiness Checks/, 'wizard must show remote readiness checks')

assert.match(routeSource, /OPENCLAW_INSTANCE_REGISTRY_JSON/, 'plan API must configure the OpenClaw instance registry')
assert.match(routeSource, /TERMINAL_SERVER_AUTOSTART=true/, 'plan API must enable the terminal sidecar for controller nodes')
assert.match(routeSource, /sshTarget/, 'plan API must support SSH bootstrap output')
assert.match(routeSource, /npm run build/, 'plan API must produce a complete install/build command')
assert.match(routeSource, /OpenShell CLI is installed/, 'plan API must return operational readiness checks')
assert.doesNotMatch(routeSource, /\/home\/nvidia|\/Users\/markmckeen/, 'plan API must not bake in developer machine paths')

console.log('controller-node-wizard-check: PASS controller node wizard assertions')
