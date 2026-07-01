# Vendored NemoClaw preload guards

This directory holds verbatim copies of two NemoClaw sandbox preload files.
They live here so `ensure-recovery-guards.sh` works on BYOVPS hosts where
the NemoClaw source tree was removed by the installer after the docker
image build (the `install_versioned_nemoclaw_openshell.sh` extracts to a
`mktemp -d` and cleans up afterwards, leaving nothing under `/opt/nemoclaw`).

## Files

| File | Upstream path | Purpose |
|---|---|---|
| `sandbox-safety-net.js` | `nemoclaw-blueprint/scripts/sandbox-safety-net.js` | Catches `unhandledRejection` / `uncaughtException` so a library bug can't take down the shared gateway. |
| `ciao-network-guard.js` | `nemoclaw-blueprint/scripts/ciao-network-guard.js` | Patches `os.networkInterfaces()` so the `@homebridge/ciao` mDNS library doesn't crash in a restricted netns. |

Both are required to satisfy the `#2478` gateway-recovery check, which globs
`*nemoclaw-sandbox-safety-net*` AND `*nemoclaw-ciao-network-guard*` against
`NODE_OPTIONS` and refuses to relaunch the gateway when either is absent. See
`/opt/nemoclaw/src/lib/agent/runtime.ts` upstream for the check itself.

## License

These files are NVIDIA's, under Apache-2.0 (their `SPDX-License-Identifier`
header is preserved verbatim at the top of each file). We vendor them
under the same license. Refresh from upstream when:

- A new NemoClaw release ships a materially different safety-net or ciao
  guard (check the git log on `nemoclaw-blueprint/scripts/`).
- The substring patterns that `gateway-recovery` looks for change in
  `runtime.ts` — if upstream renames the files, our vendored copies stop
  satisfying the check.

## How `ensure-recovery-guards.sh` chooses a source

`ensure-recovery-guards.sh` first looks at `/opt/nemoclaw/nemoclaw-blueprint/
scripts/` (the path the source tree lands at on hosts where NemoClaw was
installed via a git checkout). If that's missing, it falls back to these
vendored copies. The destination inside the container is always
`/tmp/nemoclaw-sandbox-safety-net.js` + `/tmp/nemoclaw-ciao-network-guard.js`
so the substring match against `NODE_OPTIONS` works either way.
