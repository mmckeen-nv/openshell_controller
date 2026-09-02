import assert from 'node:assert/strict'
import {
  normalizeAgentIdentifier,
  parseNemoclawListJson,
  resolveSandboxAgent,
} from '../app/lib/nemoclawIdentity.mjs'

const jsonInventory = JSON.stringify({
  schemaVersion: 1,
  sandboxes: [
    { name: 'my-hermes', agent: 'Hermes', isDefault: true },
    { name: 'gateway-recovered', agent: 'unknown', isDefault: false },
    { name: 'custom-agent', agent: 'LangChain DeepAgents Code', isDefault: false },
  ],
})

const parsed = parseNemoclawListJson(jsonInventory)
assert.ok(parsed, 'schemaVersion=1 NemoClaw JSON inventory should parse')
assert.deepEqual(parsed.defaultSandboxNames, ['my-hermes'])
assert.equal(parsed.agentsByName['my-hermes'], 'hermes')
assert.equal(parsed.agentsByName['gateway-recovered'], 'unknown')
assert.equal(parsed.agentsByName['custom-agent'], 'langchain-deepagents-code')

assert.equal(resolveSandboxAgent('my-hermes', null, parsed, null), 'hermes')
assert.equal(resolveSandboxAgent('gateway-recovered', null, parsed, null), 'unknown')
assert.equal(resolveSandboxAgent('missing-from-json', null, parsed, null), 'unknown')

assert.equal(normalizeAgentIdentifier('OpenClaw'), 'openclaw')
assert.equal(normalizeAgentIdentifier('nemohermes'), 'hermes')
assert.equal(normalizeAgentIdentifier('unknown'), 'unknown')

const legacyRegistry = {
  sandboxes: {
    'legacy-null-agent': { name: 'legacy-null-agent', agent: null },
    'explicit-hermes': { name: 'explicit-hermes', agent: 'Hermes' },
    'explicit-unknown': { name: 'explicit-unknown', agent: 'unknown' },
  },
}

assert.equal(resolveSandboxAgent('legacy-null-agent', null, null, legacyRegistry), 'openclaw')
assert.equal(resolveSandboxAgent('explicit-hermes', null, null, legacyRegistry), 'hermes')
assert.equal(resolveSandboxAgent('explicit-unknown', null, null, legacyRegistry), 'unknown')

assert.equal(parseNemoclawListJson('{'), null, 'invalid JSON must fail closed')
assert.equal(parseNemoclawListJson(JSON.stringify({ schemaVersion: 2, sandboxes: [] })), null, 'unsupported schema versions must fail closed')

console.log('nemoclaw-identity-resolution-check: PASS json identity resolution assertions')
