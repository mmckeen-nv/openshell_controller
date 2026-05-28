// Helpers for handling sandbox policy during quick-deploy (redeploy-image).
//
// The redeploy path needs the new sandbox's policy to match the source
// sandbox's — otherwise Landlock-style filesystem restrictions can deny
// execute on agent binaries that live outside the base template's allowlist
// (e.g. `/opt/hermes/.venv/bin/hermes` is not in openclaw-sandbox.yaml's
// read_only set, so Hermes won't run in a redeploy that uses that template).
//
// We avoid touching the maintained `openclaw-sandbox.yaml` and instead shell
// out to `openshell policy get <source> --full`, strip the human-readable
// header, and pass the resulting YAML as `--policy` to the create CLI.

import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/**
 * Run `openshell policy get <name> --full` against the live gateway and
 * persist the returned YAML to a temp file. Returns the path on success,
 * or null if anything went wrong (caller should fall back to a static
 * template).
 *
 * @param sourceSandboxName  Name of the sandbox whose policy to clone.
 * @param openShellBin       Absolute path to the `openshell` binary.
 * @param env                Process env to use (e.g. with OPENSHELL_GATEWAY).
 * @param timeoutMs          Defaults to 15s.
 */
export async function exportSandboxPolicyToFile(
  sourceSandboxName: string,
  openShellBin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 15000,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(openShellBin, ["policy", "get", sourceSandboxName, "--full"], {
      env,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    const raw = String(stdout ?? "")
    const yaml = stripPolicyHeader(raw)
    if (!yaml || !yaml.includes("filesystem_policy")) return null

    const tmpDir = process.env.TMPDIR || "/tmp"
    const tmpPath = path.join(tmpDir, `openshell-redeploy-policy-${process.pid}-${Date.now()}.yaml`)
    writeFileSync(tmpPath, `${yaml}\n`, { mode: 0o600 })
    return tmpPath
  } catch {
    return null
  }
}

/**
 * `openshell policy get <name> --full` prints a human-readable header
 * (Version/Hash/Status/Active/Created/Loaded), a `---` separator, then the
 * policy YAML. Strip everything up to and including the document separator
 * so the file we write is a clean YAML document the create CLI can parse.
 *
 * Exported for testability.
 */
export function stripPolicyHeader(stdout: string): string {
  const lines = String(stdout ?? "").split(/\r?\n/)
  let yamlStart = lines.findIndex((line) => /^---\s*$/.test(line))
  if (yamlStart === -1) {
    yamlStart = lines.findIndex((line) => /^version\s*:/.test(line))
  } else {
    yamlStart += 1 // skip the `---` separator line itself
  }
  if (yamlStart === -1) return ""
  return lines.slice(yamlStart).join("\n").trim()
}
