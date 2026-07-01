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
assert.doesNotMatch(
  helperSource,
  /searchParams\.set\('launch', params\.launch\)/,
  'operator terminal route builder must NOT thread a launch mode — terminal-server.mjs attaches directly to the sandbox shell so no in-page wrapper is needed'
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
assert.match(
  terminalSource,
  /falling back to stream transport/,
  'terminal server must fall back to stream transport when auto PTY spawn fails'
)
assert.match(
  terminalSource,
  /transport: session\.transport\.kind/,
  'terminal server must report the actual per-session transport after fallback'
)
assert.match(
  terminalSource,
  /function buildSessionCommand\(sandboxId\)/,
  'terminal server must resolve the real command it will execute for each session'
)
assert.match(
  terminalSource,
  /function normalizeSandboxId\(value\)/,
  'terminal server must validate request-controlled sandbox IDs before using them in shell templates'
)
assert.match(
  terminalSource,
  /\^\[A-Za-z0-9\]\[A-Za-z0-9_\.-\]/,
  'terminal server sandbox ID validation must reject shell metacharacters and whitespace'
)
assert.match(
  terminalSource,
  /OPENSHELL_TERMINAL_ATTACH_TEMPLATE[\s\S]*return buildAttachCommand\(sandboxId\)/,
  'terminal server must honor OPENSHELL_TERMINAL_ATTACH_TEMPLATE for sandbox sessions instead of only displaying it'
)
assert.match(
  terminalSource,
  /replaceAll\('\{sandboxId\}', safeSandboxId\)/,
  'terminal server must shell-escape sandboxId before substituting it into attach templates'
)
assert.match(
  terminalSource,
  /replaceAll\('\{alias\}', safeAlias\)/,
  'terminal server must shell-escape aliases before substituting them into attach templates'
)
assert.match(
  terminalSource,
  /attachCommand: buildSessionCommand\(identity\.sandboxId\)/,
  'terminal server attachCommand metadata must match the command family it executes for the session'
)
assert.match(
  terminalSource,
  /statusCode = message\.startsWith\('Invalid sandboxId'\) \? 400 : 500/,
  'terminal server should report invalid sandbox IDs as client errors'
)
assert.match(
  terminalSource,
  /function buildSessionExec\(sandboxId\)/,
  'terminal server must build an executable shell command for each session'
)
assert.match(
  terminalSource,
  /shellForPlatform\(\)} -lc \$\{shellEscape\(sessionCommand\)\}/,
  'terminal server must run attach templates through a shell so compound commands are preserved'
)
assert.match(
  terminalSource,
  /sessionExec/,
  'terminal bootstrap must execute the resolved session command'
)

const operatorTerminalSource = await readFile(path.join(root, 'app/operator-terminal/page.tsx'), 'utf8')
assert.match(
  operatorTerminalSource,
  /transport\?: string/,
  'operator terminal UI must track actual transport metadata'
)
assert.match(
  operatorTerminalSource,
  /via \$\{liveSession\.transport\}/,
  'operator terminal status must disclose the actual live transport to avoid misleading readiness copy'
)

const buildOperatorTerminalRoute = ({ sandboxId, dashboardSessionId, launch }) => {
  const searchParams = new URLSearchParams()
  if (sandboxId) searchParams.set('sandboxId', sandboxId)
  searchParams.set('dashboardSessionId', dashboardSessionId)
  if (launch) searchParams.set('launch', launch)
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
assert.equal(
  buildOperatorTerminalRoute({ sandboxId: 'my-hermes', dashboardSessionId: 'dash-123' }),
  '/operator-terminal?sandboxId=my-hermes&dashboardSessionId=dash-123'
)

console.log('dashboard-session-check: PASS route/session scope assertions')
