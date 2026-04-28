import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()

const [specSource, routeSource, pageSource, sidebarSource, helpSource] = await Promise.all([
  readFile(path.join(root, 'app/lib/openapiSpec.ts'), 'utf8'),
  readFile(path.join(root, 'app/api/openapi/route.ts'), 'utf8'),
  readFile(path.join(root, 'app/swagger/page.tsx'), 'utf8'),
  readFile(path.join(root, 'app/components/Sidebar.tsx'), 'utf8'),
  readFile(path.join(root, 'app/components/HelpPanel.tsx'), 'utf8'),
])

assert.match(specSource, /openapi:\s*"3\.1\.0"/, 'OpenAPI spec must declare version 3.1.0')
assert.match(specSource, /\/api\/controller-node\/plan/, 'spec must document controller plan endpoint')
assert.match(specSource, /\/api\/controller-node\/deploy/, 'spec must document controller deploy endpoint')
assert.match(specSource, /\/api\/controller-node\/registry/, 'spec must document controller registry endpoint')
assert.match(specSource, /ControllerDeployRequest/, 'spec must include autodeploy request schema')
assert.match(specSource, /sessionCookie/, 'spec must document session cookie auth')
assert.match(routeSource, /buildOpenApiSpec/, 'OpenAPI API route must return generated spec')
assert.match(pageSource, /OpenAPI JSON/, 'Swagger page must link to the JSON spec')
assert.match(pageSource, /Endpoints/, 'Swagger page must render endpoint docs')
assert.match(pageSource, /Schemas/, 'Swagger page must render schema docs')
assert.doesNotMatch(sidebarSource, /href="\/swagger"/, 'Swagger must not be a top-level sidebar item')
assert.match(helpSource, /API Reference/, 'Help must expose an API reference section')
assert.match(helpSource, /href="\/swagger"/, 'Help must link to the Swagger page')
assert.match(helpSource, /target="_blank"/, 'Help must open Swagger in a separate page')

console.log('swagger-openapi-check: PASS swagger/openapi assertions')
