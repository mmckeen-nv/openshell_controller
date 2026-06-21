#!/bin/bash
# Ensure NemoClaw gateway-recovery guards are present in a sandbox so the
# Hermes gateway can self-recover from an abrupt crash on BYOVPS (#2478).
#
# Usage: ensure-recovery-guards.sh <sandbox-name>
#
# NemoClaw's gateway-recovery refuses to relaunch the gateway when
# /tmp/nemoclaw-proxy-env.sh is present but NODE_OPTIONS doesn't reference
# BOTH the sandbox-safety-net.js preload AND the ciao-network-guard.js
# preload (see /opt/nemoclaw/src/lib/agent/runtime.ts line ~190). On cloud
# installs, the openshell-gateway writes these paths into NODE_OPTIONS
# automatically. On BYOVPS, that step is missing, so any gateway crash
# leaves the sandbox permanently broken until manual intervention.
#
# This script ensures the guards are present, idempotently:
#   1. Copies the real sandbox-safety-net.js + ciao-network-guard.js from
#      the NemoClaw install on the host into the sandbox container at
#      /tmp/nemoclaw-sandbox-safety-net.js and /tmp/nemoclaw-ciao-network-guard.js
#      (so the substring check in gateway-recovery matches).
#   2. Appends NODE_OPTIONS=--require=<both> to /tmp/nemoclaw-proxy-env.sh
#      if a NODE_OPTIONS line is not already present.
#
# Both steps are no-ops when already applied, so the script is safe to run
# from watchdog.sh on every 2-minute tick.
#
# Run by: expose.sh (initial provisioning) + watchdog.sh (recovery from
# container restarts that re-wrote proxy-env.sh without the guards).

TAG="[hermes-remote-recovery-guards]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: ensure-recovery-guards.sh <sandbox-name>"

CONTAINER=$(find_sandbox_container "$SANDBOX")
[ -n "$CONTAINER" ] || die "no running container for sandbox '$SANDBOX'"

# Source for the preload files. NemoClaw install path is stable across versions.
NEMOCLAW_SCRIPTS_DIR="${NEMOCLAW_SCRIPTS_DIR:-/opt/nemoclaw/nemoclaw-blueprint/scripts}"
SAFETY_NET_SRC="${NEMOCLAW_SCRIPTS_DIR}/sandbox-safety-net.js"
CIAO_GUARD_SRC="${NEMOCLAW_SCRIPTS_DIR}/ciao-network-guard.js"

# Destination paths inside the container. The literal substrings
# "nemoclaw-sandbox-safety-net" and "nemoclaw-ciao-network-guard" must
# appear somewhere in NODE_OPTIONS for the gateway-recovery check to pass.
SAFETY_NET_DEST="/tmp/nemoclaw-sandbox-safety-net.js"
CIAO_GUARD_DEST="/tmp/nemoclaw-ciao-network-guard.js"
PROXY_ENV="/tmp/nemoclaw-proxy-env.sh"

for src in "$SAFETY_NET_SRC" "$CIAO_GUARD_SRC"; do
  [ -r "$src" ] || die "NemoClaw guard source not readable: $src (is /opt/nemoclaw installed?)"
done

# ── Copy the preload files into the container (idempotent) ────────────
copy_into_container() {
  local src="$1" dest="$2" label="$3"

  # Skip copy if already in place AND content matches (same size + mtime).
  local need_copy=1
  if docker exec "$CONTAINER" test -f "$dest" 2>/dev/null; then
    local src_size dest_size
    src_size=$(stat -c '%s' "$src" 2>/dev/null || echo '')
    dest_size=$(docker exec "$CONTAINER" stat -c '%s' "$dest" 2>/dev/null || echo '')
    if [ -n "$src_size" ] && [ "$src_size" = "$dest_size" ]; then
      need_copy=0
    fi
  fi

  if [ "$need_copy" = "1" ]; then
    docker cp "$src" "$CONTAINER:$dest" \
      || die "failed to copy $label into $CONTAINER:$dest"
    # 444 so the sandbox user can read but cannot tamper.
    docker exec "$CONTAINER" chmod 444 "$dest" 2>/dev/null || true
    log "installed $label at $CONTAINER:$dest"
  fi
}

copy_into_container "$SAFETY_NET_SRC" "$SAFETY_NET_DEST" "sandbox-safety-net.js"
copy_into_container "$CIAO_GUARD_SRC" "$CIAO_GUARD_DEST" "ciao-network-guard.js"

# ── Patch proxy-env.sh with NODE_OPTIONS (idempotent) ─────────────────
# proxy-env.sh is written 444 by nemoclaw-start. We chmod u+w, append,
# then restore 444. On the next container restart, nemoclaw-start
# rewrites the file fresh — so the watchdog must re-apply this on every
# tick. The append itself is short-circuited when already present.

ensure_node_options() {
  if ! docker exec "$CONTAINER" test -f "$PROXY_ENV" 2>/dev/null; then
    log "proxy-env.sh not yet written (nemoclaw-start hasn't run) — nothing to patch"
    return 0
  fi
  if docker exec "$CONTAINER" grep -q '^export NODE_OPTIONS=' "$PROXY_ENV" 2>/dev/null; then
    # Already patched (by us on a previous tick OR by some other source).
    return 0
  fi

  docker exec "$CONTAINER" sh -c "
    chmod u+w '$PROXY_ENV' 2>/dev/null || true
    printf '\n# openshell-controller: gateway-recovery guards (#2478)\nexport NODE_OPTIONS=\"--require=%s --require=%s\"\n' \
      '$SAFETY_NET_DEST' '$CIAO_GUARD_DEST' >> '$PROXY_ENV'
    chmod 444 '$PROXY_ENV'
  " 2>/dev/null || die "failed to patch $PROXY_ENV with NODE_OPTIONS"
  log "patched $CONTAINER:$PROXY_ENV with NODE_OPTIONS guards"
}

ensure_node_options
