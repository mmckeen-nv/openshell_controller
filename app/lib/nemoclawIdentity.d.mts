export type NemoClawRegistryData = {
  sandboxes?: Record<string, { name?: string; agent?: string | null }>
}

export type NemoClawListJsonIdentity = {
  agentsByName: Record<string, string>
  defaultSandboxNames: string[]
}

export function normalizeAgentIdentifier(agent: unknown): string | null
export function parseNemoclawListJson(output: string): NemoClawListJsonIdentity | null
export function parseDefaultSandboxNames(output: string): Set<string>
export function resolveSandboxAgent(
  name: string,
  id: string | null,
  listJsonIdentity: NemoClawListJsonIdentity | null,
  registry: NemoClawRegistryData | null
): string
