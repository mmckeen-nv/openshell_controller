import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { createRequire } from 'node:module'

const root = process.cwd()
const sourcePath = path.join(root, 'app/lib/controlAuthConfig.ts')
const source = readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText

const tempDir = await mkdtemp(path.join(tmpdir(), 'nemoclaw-auth-config-'))
const envPath = path.join(tempDir, '.env.local')
const originalCwd = process.cwd()
const originalEnv = {
  password: process.env.OPENSHELL_CONTROL_PASSWORD,
  secret: process.env.OPENSHELL_CONTROL_AUTH_SECRET,
  recoveryToken: process.env.OPENSHELL_CONTROL_RECOVERY_TOKEN,
}

try {
  process.chdir(tempDir)
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    require: createRequire(sourcePath),
    exports: module.exports,
    module,
    process,
  }, { filename: sourcePath })

  await writeFile(envPath, [
    'OPENSHELL_CONTROL_PASSWORD=old-first',
    'NEXT_PUBLIC_API_BASE=/api',
    'export OPENSHELL_CONTROL_PASSWORD=old-second',
    'OPENSHELL_CONTROL_AUTH_SECRET=old-secret',
    'OPENSHELL_CONTROL_RECOVERY_TOKEN=old-token',
    '',
  ].join('\n'), 'utf8')

  await module.exports.updateLocalAuthCredentials('new password with spaces')

  const updated = readFileSync(envPath, 'utf8')
  assert.match(updated, /^OPENSHELL_CONTROL_PASSWORD="new password with spaces"$/m)
  assert.equal([...updated.matchAll(/OPENSHELL_CONTROL_PASSWORD\s*=/g)].length, 1)
  assert.equal([...updated.matchAll(/OPENSHELL_CONTROL_AUTH_SECRET\s*=/g)].length, 1)
  assert.equal([...updated.matchAll(/OPENSHELL_CONTROL_RECOVERY_TOKEN\s*=/g)].length, 1)
  assert.match(updated, /^NEXT_PUBLIC_API_BASE=\/api$/m)
  assert.equal(process.env.OPENSHELL_CONTROL_PASSWORD, 'new password with spaces')
  assert.ok(existsSync(envPath))
} finally {
  process.chdir(originalCwd)
  if (originalEnv.password === undefined) {
    delete process.env.OPENSHELL_CONTROL_PASSWORD
  } else {
    process.env.OPENSHELL_CONTROL_PASSWORD = originalEnv.password
  }
  if (originalEnv.secret === undefined) {
    delete process.env.OPENSHELL_CONTROL_AUTH_SECRET
  } else {
    process.env.OPENSHELL_CONTROL_AUTH_SECRET = originalEnv.secret
  }
  if (originalEnv.recoveryToken === undefined) {
    delete process.env.OPENSHELL_CONTROL_RECOVERY_TOKEN
  } else {
    process.env.OPENSHELL_CONTROL_RECOVERY_TOKEN = originalEnv.recoveryToken
  }
  await rm(tempDir, { recursive: true, force: true })
}

console.log('control-auth-config-check: PASS env auth credential update assertions')
