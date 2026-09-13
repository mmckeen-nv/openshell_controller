import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export function discoverNemoClawRegistryFiles(home = process.env.HOME || '/tmp') {
  const stateRoot = path.join(home, '.nemoclaw')
  const files = [path.join(stateRoot, 'sandboxes.json')]
  const gatewaysRoot = path.join(stateRoot, 'gateways')

  if (existsSync(gatewaysRoot)) {
    try {
      const ports = readdirSync(gatewaysRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^(?:[1-9][0-9]{0,4})$/.test(entry.name))
        .map((entry) => Number(entry.name))
        .filter((port) => port <= 65535)
        .sort((a, b) => a - b)
      for (const port of ports) files.push(path.join(gatewaysRoot, String(port), 'sandboxes.json'))
    } catch {
      // Individual readable registry files remain usable when directory discovery is unavailable.
    }
  }

  return files.filter((file) => existsSync(file))
}

export function readNemoClawRegistries(home = process.env.HOME || '/tmp') {
  return discoverNemoClawRegistryFiles(home).flatMap((registryFile) => {
    try {
      const data = JSON.parse(readFileSync(registryFile, 'utf8'))
      return data && typeof data === 'object' && !Array.isArray(data)
        ? [{ registryFile, data }]
        : []
    } catch {
      return []
    }
  })
}

export function findNemoClawRegistryEntry(sandboxName, home = process.env.HOME || '/tmp') {
  const matches = []
  for (const registry of readNemoClawRegistries(home)) {
    const entries = registry.data.sandboxes && typeof registry.data.sandboxes === 'object'
      ? registry.data.sandboxes
      : {}
    const keyed = entries[sandboxName]
    const entry = keyed || Object.values(entries).find((candidate) => candidate?.name === sandboxName)
    if (entry) matches.push({ entry, registryFile: registry.registryFile })
  }

  if (matches.length > 1) {
    throw new Error(`Sandbox '${sandboxName}' appears in multiple NemoClaw gateway registries; resolve the duplicate registration before quick deploy.`)
  }
  return matches[0] || null
}

export function listNemoClawRegistryCandidates(home = process.env.HOME || '/tmp') {
  const defaults = []
  const entries = []
  for (const { data } of readNemoClawRegistries(home)) {
    if (typeof data.defaultSandbox === 'string' && data.defaultSandbox.trim()) {
      defaults.push(data.defaultSandbox.trim())
    }
    for (const [key, value] of Object.entries(data.sandboxes || {})) {
      const name = typeof value?.name === 'string' && value.name.trim() ? value.name.trim() : key
      entries.push({ name, createdAt: String(value?.createdAt || '') })
    }
  }

  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return [...new Set([...defaults, ...entries.map(({ name }) => name)])]
}
