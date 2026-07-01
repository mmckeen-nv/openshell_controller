import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { hostCommandEnv } from "./hostCommands"

const execFileAsync = promisify(execFile)

export type SandboxImageMap = Map<string, string>

// Returns {sandbox-name → container image}. Powers agent-type detection both
// for the inventory feed and Quick Deploy source selection. Empty map on error
// so callers silently fall back to their prior defaults.
export async function readSandboxContainerImageMap(): Promise<SandboxImageMap> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      [
        "ps",
        "--filter",
        "label=openshell.ai/managed-by=openshell",
        "--format",
        "{{.Label \"openshell.ai/sandbox-name\"}}|{{.Image}}",
      ],
      { env: hostCommandEnv(), timeout: 5000, maxBuffer: 1024 * 1024 },
    )
    const map: SandboxImageMap = new Map()
    for (const line of String(stdout).split(/\r?\n/)) {
      const [name, image] = line.split("|")
      if (name && image) map.set(name.trim(), image.trim())
    }
    return map
  } catch {
    return new Map()
  }
}

// True when the image was built by NemoClaw (OpenClaw or Hermes sandboxes).
// Bare `openshell sandbox create` uses a different image
// (ghcr.io/nvidia/openshell-community/sandboxes/base) and is treated as
// Custom.
export function isNemoClawImage(image: string | undefined | null) {
  return Boolean(image) && /openshell\/sandbox-from/i.test(String(image))
}
