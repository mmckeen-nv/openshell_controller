import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

// Helper to generate a Node-signed HS256 JWT for validation tests
function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' }
  const base64Url = (str) => Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  const h = base64Url(JSON.stringify(header))
  const p = base64Url(JSON.stringify(payload))
  const signature = crypto.createHmac('sha256', secret)
    .update(`${h}.${p}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `${h}.${p}.${signature}`
}

const originalEnv = {
  mcpauthSecret: process.env.MCPAUTH_JWT_SECRET,
  cfauthSecret: process.env.CF_AUTH_JWT_SECRET,
  sandboxUsers: process.env.SANDBOX_ACCESS_USERS,
}

try {
  delete process.env.MCPAUTH_JWT_SECRET
  delete process.env.CF_AUTH_JWT_SECRET
  delete process.env.SANDBOX_ACCESS_USERS

  const module = { exports: {} }
  // Next.js Edge Runtime mock global context
  const mockGlobal = {
    require: createRequire(sourcePath),
    exports: module.exports,
    module,
    process,
    URL,
    crypto: {
      subtle: {
        async importKey(format, keyData, algorithm, extractable, keyUsages) {
          const keyBuffer = Buffer.from(keyData)
          return { keyBuffer, algorithm }
        },
        async sign(algorithm, key, data) {
          const hmac = crypto.createHmac('sha256', key.keyBuffer)
          hmac.update(Buffer.from(data))
          return hmac.digest()
        }
      }
    },
    TextEncoder: class {
      encode(str) { return Buffer.from(str) }
    },
    TextDecoder: class {
      decode(buf) { return Buffer.from(buf).toString() }
    },
    btoa(str) { return Buffer.from(str, 'binary').toString('base64') },
    atob(str) { return Buffer.from(str, 'base64').toString('binary') },
  }

  vm.runInNewContext(compiled, mockGlobal, { filename: sourcePath })

  const auth = module.exports

  // Test 1: getCFAuthSecret
  assert.equal(auth.getCFAuthSecret(), 'my-secret-key')
  process.env.CF_AUTH_JWT_SECRET = 'cf-custom-secret'
  assert.equal(auth.getCFAuthSecret(), 'cf-custom-secret')
  process.env.MCPAUTH_JWT_SECRET = 'mcp-custom-secret'
  assert.equal(auth.getCFAuthSecret(), 'mcp-custom-secret')

  // Test 2: getSandboxAccessMap
  process.env.SANDBOX_ACCESS_USERS = 'sandbox-1:alice@co.com,sandbox-1:bob@co.com,sandbox-2:charlie@co.com'
  const map = auth.getSandboxAccessMap()
  assert.ok(map)
  assert.equal(map.constructor.name, 'Map')
  assert.equal(map.get('sandbox-1').has('alice@co.com'), true)
  assert.equal(map.get('sandbox-1').has('bob@co.com'), true)
  assert.equal(map.get('sandbox-1').has('charlie@co.com'), false)
  assert.equal(map.get('sandbox-2').has('charlie@co.com'), true)

  // Test 3: isUserAuthorizedForSandbox
  assert.equal(auth.isUserAuthorizedForSandbox('alice@co.com', 'sandbox-1'), true)
  assert.equal(auth.isUserAuthorizedForSandbox('bob@co.com', 'sandbox-1'), true)
  assert.equal(auth.isUserAuthorizedForSandbox('charlie@co.com', 'sandbox-1'), false)
  assert.equal(auth.isUserAuthorizedForSandbox('charlie@co.com', 'sandbox-2'), true)
  assert.equal(auth.isUserAuthorizedForSandbox('operator', 'sandbox-2'), false) // strict mapping checks

  // Test 4: verifyCFAuthorizationJWT - Valid Token
  const now = Math.floor(Date.now() / 1000)
  const validPayload = { sub: 'alice@co.com', email: 'alice@co.com', exp: now + 3600 }
  const validSecret = 'mcp-custom-secret'
  const validToken = signJWT(validPayload, validSecret)

  const parsedPayload = await auth.verifyCFAuthorizationJWT(validToken)
  assert.ok(parsedPayload)
  assert.equal(parsedPayload.email, 'alice@co.com')

  // Test 5: verifyCFAuthorizationJWT - Expired Token
  const expiredPayload = { sub: 'alice@co.com', email: 'alice@co.com', exp: now - 60 }
  const expiredToken = signJWT(expiredPayload, validSecret)
  const parsedExpired = await auth.verifyCFAuthorizationJWT(expiredToken)
  assert.equal(parsedExpired, null)

  // Test 6: verifyCFAuthorizationJWT - Signature Mismatch / Tampered
  const wrongSecretToken = signJWT(validPayload, 'wrong-secret')
  const parsedWrongSecret = await auth.verifyCFAuthorizationJWT(wrongSecretToken)
  assert.equal(parsedWrongSecret, null)

  console.log('control-auth-mcpauth-check: PASS all MCPAuth IDP JWT and sandbox authorization assertions')
} finally {
  // Restore process.env
  if (originalEnv.mcpauthSecret === undefined) delete process.env.MCPAUTH_JWT_SECRET
  else process.env.MCPAUTH_JWT_SECRET = originalEnv.mcpauthSecret

  if (originalEnv.cfauthSecret === undefined) delete process.env.CF_AUTH_JWT_SECRET
  else process.env.CF_AUTH_JWT_SECRET = originalEnv.cfauthSecret

  if (originalEnv.sandboxUsers === undefined) delete process.env.SANDBOX_ACCESS_USERS
  else process.env.SANDBOX_ACCESS_USERS = originalEnv.sandboxUsers
}
