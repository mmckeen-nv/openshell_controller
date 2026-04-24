import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const pagePath = path.join(root, 'app/page.tsx')
const sandboxListPath = path.join(root, 'app/components/SandboxList.tsx')
const hookPath = path.join(root, 'app/hooks/useSandboxInventory.ts')

const pageSource = await readFile(pagePath, 'utf8')
const sandboxListSource = await readFile(sandboxListPath, 'utf8')
const hookSource = await readFile(hookPath, 'utf8')

assert.match(hookSource, /const \[loading, setLoading\] = useState\(false\)/, 'authoritative inventory hook must use SSR-safe loading initialization')
assert.match(hookSource, /const \[error, setError\] = useState<string \| null>\(null\)/, 'authoritative inventory hook must own error state')
assert.match(pageSource, /const \{ sandboxes, nemoclaw, loading, error, refresh \} = useSandboxInventory\(/, 'page must read loading and error from useSandboxInventory')
assert.match(pageSource, /inventoryEnabled && loading \? \(/, 'page must render initializing from authoritative inventory state')
assert.match(pageSource, /data-testid="inventory-loading-state"/, 'page must expose loading state marker')
assert.match(pageSource, /inventoryEnabled && error \? \(/, 'page must render error state from authoritative inventory state')
assert.match(pageSource, /data-testid="inventory-error-state"/, 'page must expose error state marker')
assert.match(pageSource, /sandboxes\.length === 0 \? \(/, 'page must render explicit empty state when inventory is valid but empty')
assert.match(pageSource, /data-testid="inventory-empty-state"/, 'page must expose empty state marker')
assert.doesNotMatch(sandboxListSource, /const \[loading, setLoading\] = useState\(/, 'SandboxList must not own a local loading latch')
assert.doesNotMatch(sandboxListSource, /INITIALIZING\.\.\./, 'SandboxList must not render initializing placeholder')

console.log('initializing-hang-check: PASS page-owned startup/error/empty state assertions')
