// Pure agent-filtering logic for Quick Deploy (redeploy-image) source
// candidate selection.
//
// Inputs come from two places — the NemoClaw registry on the controller
// (which carries `agent` metadata for each sandbox) and the live OpenShell
// sandbox list (which doesn't). When the user picks an agent type for
// Quick Deploy, we MUST avoid cloning from a mismatched-agent source — a
// hermes image satisfying an openclaw request (or vice versa) lands the
// wrong runtime in the new sandbox.

export type NemoClawAgent = "openclaw" | "hermes"

export type RegistryShape = {
  sandboxes?: Record<string, { name?: string; createdAt?: string; agent?: string }>
  defaultSandbox?: string | null
}

export type BucketResult = {
  candidates: string[]
  matched: string[]
  unknown: string[]
  excluded: string[]
}

/**
 * Pick the registry's known agent for a sandbox name. Returns the literal
 * "unknown" when there's no registry entry (e.g. for sandboxes created
 * outside the dashboard).
 */
export function registryAgentForName(registry: RegistryShape, name: string): "openclaw" | "hermes" | "unknown" {
  const entry = registry.sandboxes?.[name]
  const value = typeof entry?.agent === "string" ? entry.agent.trim() : ""
  if (!value) return "unknown"
  if (value === "hermes" || value === "openclaw") return value
  return "unknown"
}

/**
 * Order candidate sandbox names for Quick Deploy. When `agentFilter` is null,
 * preserves the input order (deduplicated). When set, returns matched-agent
 * candidates first, then unknown-agent (live sandboxes not in the registry),
 * with mismatched-agent candidates excluded.
 *
 * @returns The ordered, deduplicated candidate list, plus per-bucket lists for
 *          logging / debug output.
 */
export function bucketCandidatesByAgent(
  seeds: Array<string | null | undefined>,
  registry: RegistryShape,
  agentFilter: NemoClawAgent | null,
): BucketResult {
  // Deduplicate while preserving first-seen order.
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const raw of seeds) {
    if (typeof raw !== "string") continue
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    ordered.push(trimmed)
  }

  if (!agentFilter) {
    return { candidates: ordered, matched: ordered.slice(), unknown: [], excluded: [] }
  }

  const matched: string[] = []
  const unknown: string[] = []
  const excluded: string[] = []
  for (const name of ordered) {
    const tag = registryAgentForName(registry, name)
    if (tag === agentFilter) matched.push(name)
    else if (tag === "unknown") unknown.push(name)
    else excluded.push(name)
  }
  return { candidates: [...matched, ...unknown], matched, unknown, excluded }
}
