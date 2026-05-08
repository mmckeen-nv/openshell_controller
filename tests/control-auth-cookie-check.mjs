import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createRequire } from 'node:module'

const root = process.cwd()
const sourcePath = path.join(root, 'app/lib/controlAuth.ts')
const source = readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText

function mockRequest(protocol, headers = {}) {
  return {
    nextUrl: { protocol },
    headers: {
      get(name) {
        return headers[name.toLowerCase()] || null
      },
    },
  }
}

const originalEnv = {
  cookieSecure: process.env.OPENSHELL_CONTROL_COOKIE_SECURE,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
}

try {
  delete process.env.OPENSHELL_CONTROL_COOKIE_SECURE
  delete process.env.PUBLIC_BASE_URL

  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    require: createRequire(sourcePath),
    exports: module.exports,
    module,
    process,
    URL,
  }, { filename: sourcePath })

  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('http:')), false)
  assert.equal(module.exports.sessionCookieOptionsForRequest(mockRequest('http:')).secure, false)
  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('https:')), true)
  assert.equal(
    module.exports.shouldUseSecureSessionCookie(mockRequest('http:', { 'x-forwarded-proto': 'https' })),
    true,
  )

  process.env.PUBLIC_BASE_URL = 'https://control.example.test'
  assert.equal(module.exports.shouldUseSecureSessionCookie(), true)

  process.env.OPENSHELL_CONTROL_COOKIE_SECURE = 'false'
  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('https:')), false)

  process.env.OPENSHELL_CONTROL_COOKIE_SECURE = 'true'
  assert.equal(module.exports.shouldUseSecureSessionCookie(mockRequest('http:')), true)
} finally {
  if (originalEnv.cookieSecure === undefined) {
    delete process.env.OPENSHELL_CONTROL_COOKIE_SECURE
  } else {
    process.env.OPENSHELL_CONTROL_COOKIE_SECURE = originalEnv.cookieSecure
  }

  if (originalEnv.publicBaseUrl === undefined) {
    delete process.env.PUBLIC_BASE_URL
  } else {
    process.env.PUBLIC_BASE_URL = originalEnv.publicBaseUrl
  }
}

console.log('control-auth-cookie-check: PASS request-aware secure cookie assertions')
