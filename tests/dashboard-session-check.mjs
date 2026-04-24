import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const helperPath = path.join(root, 'app/lib/dashboardSession.ts')
const routePath = path.join(root, 'app/api/openshell/terminal/live/route.ts')
const terminalPath = path.join(root, 'terminal-server.mjs')

const helperSource = await readFile(helperPath, 'utf8')
assert.match(helperSource, /buildOperatorTerminalRoute/, 'dashboard session helper must define buildOperatorTerminalRoute')
assert.match(helperSource, /dashboardSessionId/, 'dashboard session helper must include dashboardSessionId handling')
assert.match(helperSource, /sessionStorage/, 'dashboard session helper should persist tab-scoped state in sessionStorage')
assert.match(
  helperSource,
  /searchParams\.set\('dashboardSessionId', params\.dashboardSessionId\)/,
  'operator terminal route builder must thread dashboardSessionId'
)

const routeSource = await readFile(routePath, 'utf8')
assert.match(routeSource, /dashboardSessionId/, 'terminal live route must accept dashboardSessionId')
assert.match(
  routeSource,
  /websocketUrl\.searchParams\.set\('dashboardSessionId', params\.dashboardSessionId\)/,
  'terminal websocket URL must include dashboardSessionId'
)
assert.match(
  routeSource,
  /body: JSON\.stringify\([\s\S]*dashboardSessionId[\s\S]*\)/,
  'terminal live route must forward dashboardSessionId to terminal server'
)

const terminalSource = await readFile(terminalPath, 'utf8')
assert.match(
  terminalSource,
  /existing\.dashboardSessionId === identity\.dashboardSessionId/,
  'terminal server must only reuse sessions when dashboardSessionId matches'
)
assert.match(
  terminalSource,
  /dashboardSessionId: session\.dashboardSessionId/,
  'terminal server responses must expose dashboardSessionId metadata'
)

const buildOperatorTerminalRoute = ({ sandboxId, dashboardSessionId }) => {
  const searchParams = new URLSearchParams()
  if (sandboxId) searchParams.set('sandboxId', sandboxId)
  searchParams.set('dashboardSessionId', dashboardSessionId)
  const query = searchParams.toString()
  return query ? `/operator-terminal?${query}` : '/operator-terminal'
}

assert.equal(
  buildOperatorTerminalRoute({ sandboxId: 'sandbox-a', dashboardSessionId: 'dash-123' }),
  '/operator-terminal?sandboxId=sandbox-a&dashboardSessionId=dash-123'
)
assert.equal(
  buildOperatorTerminalRoute({ sandboxId: null, dashboardSessionId: 'dash-123' }),
  '/operator-terminal?dashboardSessionId=dash-123'
)

console.log('dashboard-session-check: PASS route/session scope assertions')
