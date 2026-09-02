function canonicalizeAgent(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function normalizeAgentIdentifier(agent) {
  if (typeof agent !== 'string') return null
  const trimmed = agent.trim()
  if (!trimmed) return null

  const compact = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (compact === 'openclaw') return 'openclaw'
  if (compact === 'nemohermes' || compact === 'hermes') return 'hermes'
  if (compact.includes('openclaw')) return 'openclaw'
  if (compact.includes('hermes')) return 'hermes'

  const canonical = canonicalizeAgent(trimmed)
  if (!canonical) return null
  if (canonical === 'unknown') return 'unknown'
  return canonical
}

export function parseNemoclawListJson(output) {
  if (typeof output !== 'string' || output.trim().length === 0) return null

  try {
    const parsed = JSON.parse(output)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.schemaVersion !== 1) return null
    if (!Array.isArray(parsed.sandboxes)) return null

    const agentsByName = {}
    const defaultSandboxNames = []

    for (const entry of parsed.sandboxes) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const name = typeof entry.name === 'string' ? entry.name.trim() : ''
      if (!name) continue

      const normalized = normalizeAgentIdentifier(entry.agent)
      agentsByName[name] = normalized || 'unknown'
      if (entry.isDefault === true) defaultSandboxNames.push(name)
    }

    return {
      agentsByName,
      defaultSandboxNames,
    }
  } catch {
    return null
  }
}

export function parseDefaultSandboxNames(output) {
  return new Set(
    output
      .split(/\r?\n/)
      .map((entry) => entry.replace(/\u001b\[[0-9;]*m/g, ''))
      .filter((entry) => /^\s{2,}[\w.-]+(?:\s+\*)?\s*$/.test(entry) && entry.includes('*'))
      .map((entry) => entry.replace('*', '').trim())
      .filter(Boolean)
  )
}

export function resolveSandboxAgent(name, id, listJsonIdentity, registry) {
  if (listJsonIdentity) {
    const direct = listJsonIdentity.agentsByName[name] || (id ? listJsonIdentity.agentsByName[id] : null)
    return direct || 'unknown'
  }

  const entries = registry?.sandboxes || {}
  const directEntry = entries[name] || (id ? entries[id] : undefined)
  const namedEntry = Object.values(entries).find((entry) => entry?.name === name || Boolean(id && entry?.name === id))
  const normalized = normalizeAgentIdentifier(directEntry?.agent ?? namedEntry?.agent)

  if (normalized) return normalized
  return 'openclaw'
}
