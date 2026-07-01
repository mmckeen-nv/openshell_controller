// Pure agent-filtering logic for Quick Deploy (redeploy-image) source
// candidate selection.
//
// Inputs come from two places — the NemoClaw registry on the controller
// (which carries `agent` metadata for each sandbox) and the live OpenShell
// sandbox list (which doesn't). When the user picks an agent type for
// Quick Deploy, we MUST avoid cloning from a mismatched-agent source — a
// hermes image satisfying an openclaw request (or vice versa) lands the
// wrong runtime in the new sandbox. A "custom" clone also has to land on a
// bare openshell image, not a NemoClaw-built one.

export type NemoClawAgent = "openclaw" | "hermes"
export type QuickDeployAgent = NemoClawAgent | "custom"

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

const NEMOCLAW_IMAGE_PATTERN = /openshell\/sandbox-from/i

/**
 * Classify a sandbox into one of openclaw / hermes / custom / unknown using
 * both the registry agent field and (optionally) the container image. The
 * image map lets us distinguish a Custom sandbox (no registry entry + bare
 * openshell image) from an ambiguous one (no registry entry + image data
 * missing).
 */
export function classifySandbox(
  registry: RegistryShape,
  name: string,
  imageMap?: Map<string, string>,
): "openclaw" | "hermes" | "custom" | "unknown" {
  const registryTag = registryAgentForName(registry, name)
  if (registryTag !== "unknown") return registryTag
  if (!imageMap) return "unknown"
  const image = imageMap.get(name)
  if (!image) return "unknown"
  if (NEMOCLAW_IMAGE_PATTERN.test(image)) return "unknown" // NemoClaw image but unlabelled — leave as ambiguous
  return "custom"
}

/**
 * Order candidate sandbox names for Quick Deploy. When `agentFilter` is null,
 * preserves the input order (deduplicated). When set to "openclaw"/"hermes",
 * returns matched-agent candidates first, then unknown-agent (live sandboxes
 * not in the registry, no image data), with mismatched-agent candidates
 * excluded. When set to "custom", returns ONLY sandboxes positively
 * identified as Custom — the unknown bucket stays empty so we never
 * accidentally clone a NemoClaw image as Custom.
 */
export function bucketCandidatesByAgent(
  seeds: Array<string | null | undefined>,
  registry: RegistryShape,
  agentFilter: QuickDeployAgent | null,
  imageMap?: Map<string, string>,
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
    const tag = classifySandbox(registry, name, imageMap)
    if (tag === agentFilter) matched.push(name)
    else if (tag === "unknown" && agentFilter !== "custom") unknown.push(name)
    else excluded.push(name)
  }
  return { candidates: [...matched, ...unknown], matched, unknown, excluded }
}
