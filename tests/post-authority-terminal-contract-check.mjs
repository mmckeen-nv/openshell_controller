import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const routePath = path.join(root, 'app/api/openshell/terminal/live/route.ts')
const pagePath = path.join(root, 'app/operator-terminal/page.tsx')

const routeSource = await readFile(routePath, 'utf8')
assert.match(
  routeSource,
  /throw new Error\('No routable browser host available for terminal websocket URL\. Set PUBLIC_BROWSER_HOST or PUBLIC_BASE_URL\.'\)/,
  'terminal live route must fail closed when only non-routable browser hosts are available'
)
assert.doesNotMatch(
  routeSource,
  /return requestUrl\.host/,
  'terminal live route must not fall back to requestUrl.host when it is non-routable'
)
assert.match(
  routeSource,
  /const requestHostHeader = requestUrl\.host/,
  'terminal live route should inspect request host before deciding routability'
)
assert.match(
  routeSource,
  /return null/,
  'terminal live route must return null when no routable browser host is available'
)

const pageSource = await readFile(pagePath, 'utf8')
assert.match(
  pageSource,
  /sandboxId \? 'Live operator terminal for the selected sandbox, brokered through the dashboard-owned terminal bridge\.'/,
  'operator terminal page must describe sandbox-scoped terminal behavior honestly'
)
assert.match(
  pageSource,
  /: 'Live operator terminal for host mode, brokered through the dashboard-owned terminal bridge\.'/,
  'operator terminal page must distinguish host mode from sandbox mode'
)
assert.doesNotMatch(
  pageSource,
  /Live operator terminal for the host machine\. The selected sandbox is preserved as context for helper commands and status lookups, but this shell is intentionally machine-scoped\./,
  'operator terminal page must not keep the stale host-machine-only description'
)

console.log('post-authority-terminal-contract-check: PASS websocket host + UI honesty assertions')
