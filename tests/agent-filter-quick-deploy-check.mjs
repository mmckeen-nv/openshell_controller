// Behavioural tests for app/lib/sandboxCreate/agentFilter.ts.
//
// Quick Deploy uses bucketCandidatesByAgent() to pick a source sandbox image
// that matches the requested agent type. The "custom" filter, added when the
// dashboard learned to recognise bare-openshell sandboxes alongside
// OpenClaw/Hermes, has to:
//   1. Match only sandboxes whose registry agent is unset AND whose image
//      is NOT a NemoClaw-built openshell/sandbox-from:* image.
//   2. Never include the "unknown" bucket, so an ambiguous NemoClaw image
//      isn't accidentally cloned as Custom.
//
// The OpenClaw / Hermes filters keep their existing "matched + unknown"
// behaviour for back-compat.

import assert from 'node:assert/strict'
import { bucketCandidatesByAgent, classifySandbox, registryAgentForName } from '../app/lib/sandboxCreate/agentFilter.ts'

const registry = {
  sandboxes: {
    'oc-1': { name: 'oc-1', agent: 'openclaw', createdAt: '2026-06-22T10:00:00Z' },
    'hr-1': { name: 'hr-1', agent: 'hermes', createdAt: '2026-06-22T11:00:00Z' },
    // 'cust-1' has no registry entry on purpose.
    // 'old-oc' has a stale entry without an agent field.
    'old-oc': { name: 'old-oc', createdAt: '2026-06-22T09:00:00Z' },
  },
}

const imageMap = new Map([
  ['oc-1', 'openshell/sandbox-from:1234'],
  ['hr-1', 'openshell/sandbox-from:5678'],
  ['cust-1', 'ghcr.io/nvidia/openshell-community/sandboxes/base:latest'],
  ['old-oc', 'openshell/sandbox-from:9999'], // unknown agent + NemoClaw image → ambiguous
])

// 1. classifySandbox sanity
assert.equal(classifySandbox(registry, 'oc-1', imageMap), 'openclaw')
assert.equal(classifySandbox(registry, 'hr-1', imageMap), 'hermes')
assert.equal(classifySandbox(registry, 'cust-1', imageMap), 'custom')
assert.equal(classifySandbox(registry, 'old-oc', imageMap), 'unknown', 'NemoClaw image without an agent label must stay unknown — not Custom')
assert.equal(classifySandbox(registry, 'never-seen', imageMap), 'unknown', 'a sandbox missing from both registry AND image map is unknown')
assert.equal(classifySandbox(registry, 'cust-1'), 'unknown', 'without the image map, an unlabelled sandbox cannot be promoted to Custom')

// 2. registryAgentForName fallback unchanged
assert.equal(registryAgentForName(registry, 'oc-1'), 'openclaw')
assert.equal(registryAgentForName(registry, 'cust-1'), 'unknown')

// 3. Custom filter must include Custom sandboxes only
const seeds = ['oc-1', 'hr-1', 'cust-1', 'old-oc', 'never-seen']
const custom = bucketCandidatesByAgent(seeds, registry, 'custom', imageMap)
assert.deepEqual(custom.candidates, ['cust-1'], 'Custom filter must surface ONLY positively-identified Custom sandboxes')
assert.deepEqual(custom.unknown, [], 'Custom filter must keep the unknown bucket empty so ambiguous images are never cloned as Custom')
assert.ok(custom.excluded.includes('oc-1'))
assert.ok(custom.excluded.includes('hr-1'))
assert.ok(custom.excluded.includes('old-oc'), 'NemoClaw image without a label must not be eligible for Custom Quick Deploy')

// 4. OpenClaw filter retains matched + unknown back-compat semantics. The
// unknown bucket sweeps up sandboxes the registry hasn't labelled — both
// pure unknowns (never-seen) and ambiguous NemoClaw images (old-oc).
const openclaw = bucketCandidatesByAgent(seeds, registry, 'openclaw', imageMap)
assert.deepEqual(openclaw.matched, ['oc-1'])
assert.deepEqual(openclaw.unknown, ['old-oc', 'never-seen'], 'OpenClaw filter falls back to sandboxes the registry has not yet labelled')
assert.ok(!openclaw.candidates.includes('hr-1'), 'Hermes sandbox must be excluded from an OpenClaw clone')
assert.ok(!openclaw.candidates.includes('cust-1'), 'Custom sandbox (bare openshell image) must be excluded from an OpenClaw clone')

// 5. Hermes filter is symmetric
const hermes = bucketCandidatesByAgent(seeds, registry, 'hermes', imageMap)
assert.deepEqual(hermes.matched, ['hr-1'])
assert.ok(!hermes.candidates.includes('cust-1'), 'Custom sandbox must be excluded from a Hermes clone')

// 6. Null filter still preserves input order (deduplicated)
const ordered = bucketCandidatesByAgent(['a', 'b', 'a', '', 'c'], registry, null)
assert.deepEqual(ordered.candidates, ['a', 'b', 'c'])

console.log('agent-filter-quick-deploy-check: PASS')
