import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

const [wizardSource, sidebarSource, planRouteSource, deployRouteSource, registryRouteSource, planLibSource, registryLibSource] = await Promise.all([
  readFile(path.join(root, 'app/components/WizardPanel.tsx'), 'utf8'),
  readFile(path.join(root, 'app/components/Sidebar.tsx'), 'utf8'),
  readFile(path.join(root, 'app/api/controller-node/plan/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/controller-node/deploy/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/controller-node/registry/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/lib/controllerNodePlan.ts'), 'utf8'),
  readFile(path.join(root, 'app/lib/controllerNodeRegistry.ts'), 'utf8'),
])

assert.match(wizardSource, /Spawn a Controller Node/, 'wizard must expose a controller-node workflow')
assert.match(wizardSource, /Generate Launch Kit/, 'controller workflow must generate a launch kit')
assert.match(wizardSource, /Manual Deploy/, 'wizard must expose manual deploy mode')
assert.match(wizardSource, /Autodeploy/, 'wizard must expose autodeploy mode')
assert.match(wizardSource, /\/api\/controller-node\/plan/, 'wizard must call the controller-node plan API')
assert.match(wizardSource, /\/api\/controller-node\/deploy/, 'wizard must call the controller-node deploy API')
assert.match(wizardSource, /SSH Password/, 'autodeploy must collect a password for one-time SSH use')
assert.match(wizardSource, /Allow sudo/, 'autodeploy must require explicit sudo permission')
assert.match(wizardSource, /Trust first host key/, 'autodeploy must expose explicit host-key trust')
assert.match(wizardSource, /OPENCLAW_DASHBOARD_URL|OpenClaw Dashboard URL/, 'wizard must collect the remote OpenClaw upstream')
assert.match(wizardSource, /OPENSHELL_GATEWAY|OpenShell Gateway/, 'wizard must collect the remote OpenShell gateway context')
assert.match(wizardSource, /Controller Env/, 'wizard must expose the generated controller environment')
assert.match(wizardSource, /Readiness Checks/, 'wizard must show remote readiness checks')
assert.match(wizardSource, /aria-expanded=\{controllerWizardOpen\}/, 'controller node wizard must render as an accordion')
assert.match(wizardSource, /aria-expanded=\{cloneWizardOpen\}/, 'clone wizard must render as an accordion')

assert.match(planRouteSource, /buildControllerNodePlan/, 'plan API must use shared controller plan builder')
assert.match(planRouteSource, /upsertControllerNode/, 'plan API must register generated controller nodes')
assert.match(planLibSource, /OPENCLAW_INSTANCE_REGISTRY_JSON/, 'plan builder must configure the OpenClaw instance registry')
assert.match(planLibSource, /CONTROLLER_NODE_PARENT_URL/, 'plan builder must configure parent controller connectivity')
assert.match(planLibSource, /CONTROLLER_NODE_SHARED_SECRET/, 'plan builder must generate a node shared secret')
assert.match(planLibSource, /TERMINAL_SERVER_AUTOSTART=true/, 'plan builder must enable the terminal sidecar for controller nodes')
assert.match(planLibSource, /openshell-controller-node\.service/, 'plan builder must include a production service unit when systemd is available')
assert.match(planLibSource, /npm run build/, 'plan builder must produce a complete install/build command')
assert.match(planLibSource, /OpenShell CLI is installed/, 'plan builder must return operational readiness checks')
assert.match(deployRouteSource, /ssh2/, 'deploy API must use server-side SSH for autodeploy')
assert.match(deployRouteSource, /remotePassword/, 'deploy API must accept one-time remote password input')
assert.match(deployRouteSource, /sudo -S/, 'deploy API must support explicit sudo elevation')
assert.match(deployRouteSource, /expectedHostKeySha256/, 'deploy API must support host-key fingerprint verification')
assert.match(deployRouteSource, /acceptUnknownHostKey/, 'deploy API must require explicit trust-on-first-deploy')
assert.match(sidebarSource, /OpenShell Control/, 'sidebar must keep the OpenShell Control header')
assert.match(sidebarSource, /\/api\/controller-node\/registry/, 'sidebar must load managed controller nodes')
assert.match(sidebarSource, /Friendly Name/, 'sidebar must allow friendly names for controller nodes')
assert.match(sidebarSource, /Managed Node/, 'sidebar must expose a managed-node selector')
assert.match(registryRouteSource, /listControllerNodes/, 'registry API must expose controller nodes')
assert.match(registryRouteSource, /renameControllerNode/, 'registry API must support friendly-name updates')
assert.match(registryLibSource, /OPENSHELL_CONTROLLER_NODES_JSON|OPENCLAW_INSTANCE_REGISTRY_JSON/, 'registry must detect configured remote controller nodes')
assert.doesNotMatch(`${planRouteSource}\n${deployRouteSource}\n${planLibSource}\n${registryLibSource}`, /\/home\/nvidia|\/Users\/markmckeen/, 'controller node code must not bake in developer machine paths')

console.log('controller-node-wizard-check: PASS controller node wizard assertions')
