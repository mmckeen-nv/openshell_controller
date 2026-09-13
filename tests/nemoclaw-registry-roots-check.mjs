import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  discoverNemoClawRegistryFiles,
  findNemoClawRegistryEntry,
  listNemoClawRegistryCandidates,
} from '../app/lib/nemoclawRegistry.mjs'

const home = await mkdtemp(path.join(os.tmpdir(), 'nemoclaw-registry-roots-'))
try {
  const root = path.join(home, '.nemoclaw')
  await mkdir(path.join(root, 'gateways', '8990'), { recursive: true })
  await mkdir(path.join(root, 'gateways', 'not-a-port'), { recursive: true })
  await writeFile(path.join(root, 'sandboxes.json'), JSON.stringify({
    defaultSandbox: 'base-box',
    sandboxes: {
      'base-box': { name: 'base-box', imageTag: 'base:image', createdAt: '2026-09-01' },
    },
  }))
  await writeFile(path.join(root, 'gateways', '8990', 'sandboxes.json'), JSON.stringify({
    defaultSandbox: 'port-box',
    sandboxes: {
      'port-box': { name: 'port-box', imageTag: 'port:image', createdAt: '2026-09-02' },
    },
  }))
  await writeFile(path.join(root, 'gateways', 'not-a-port', 'sandboxes.json'), '{}')

  const files = discoverNemoClawRegistryFiles(home)
  assert.deepEqual(files, [
    path.join(root, 'sandboxes.json'),
    path.join(root, 'gateways', '8990', 'sandboxes.json'),
  ], 'registry discovery must include the default root and numeric alternate-port roots only')

  assert.equal(
    findNemoClawRegistryEntry('port-box', home)?.entry.imageTag,
    'port:image',
    'quick deploy must resolve image metadata from an alternate-port registry',
  )
  assert.deepEqual(
    listNemoClawRegistryCandidates(home),
    ['base-box', 'port-box'],
    'defaults remain first and registered candidates are deduplicated across roots',
  )

  await writeFile(path.join(root, 'sandboxes.json'), JSON.stringify({
    sandboxes: { duplicate: { name: 'port-box', imageTag: 'wrong:image' } },
  }))
  assert.throws(
    () => findNemoClawRegistryEntry('port-box', home),
    /multiple NemoClaw gateway registries/,
    'ambiguous cross-port registrations must fail closed',
  )

  console.log('nemoclaw-registry-roots-check: PASS cross-port registry resolution assertions')
} finally {
  await rm(home, { recursive: true, force: true })
}
