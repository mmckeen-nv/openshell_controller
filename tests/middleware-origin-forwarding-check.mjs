import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const middlewarePath = path.join(root, 'middleware.ts')
const middlewareSource = await readFile(middlewarePath, 'utf8')

assert.match(
  middlewareSource,
  /function trustedRequestOrigins\(request: NextRequest\)/,
  'middleware must collect trusted request origins for state-changing requests'
)
assert.match(
  middlewareSource,
  /request\.headers\.get\("x-forwarded-host"\)/,
  'origin check must trust the forwarded public host behind a reverse proxy'
)
assert.match(
  middlewareSource,
  /request\.headers\.get\("x-forwarded-proto"\)/,
  'origin check must preserve the forwarded public protocol behind a reverse proxy'
)
assert.match(
  middlewareSource,
  /process\.env\.PUBLIC_BASE_URL/,
  'origin check should support an explicitly configured public base URL'
)
assert.match(
  middlewareSource,
  /trustedRequestOrigins\(request\)\.has\(new URL\(origin\)\.origin\)/,
  'origin check must compare browser Origin against the trusted origin set'
)
assert.doesNotMatch(
  middlewareSource,
  /new URL\(origin\)\.origin === request\.nextUrl\.origin/,
  'origin check must not only compare against the internal Next request origin'
)

console.log('middleware-origin-forwarding-check: PASS forwarded origin trust assertions')
