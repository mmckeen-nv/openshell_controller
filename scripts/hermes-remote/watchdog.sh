#!/bin/bash
# Self-heal every exposed Hermes sandbox. Run by hermes-remote-watchdog.timer
# every 2 minutes. Covers plan risk #11: sandbox restarts change the gateway
# PID/netns, killing the dashboard; launch.sh re-discovers and relaunches.
# Forwards are systemd-supervised already, but we nudge any that wedged.
#
# BYOVPS gateway-crash recovery (#2478):
# The Hermes gateway cannot self-recover from abrupt crashes (SIGKILL / OOM /
# Python exception) because gateway-recovery only forks on graceful SIGTERM.
# When the gateway dies abruptly AND /tmp/nemoclaw-proxy-env.sh exists (as it
# always does on BYOVPS after the first startup), gateway-recovery refuses to
# restart because NODE_OPTIONS lacks the sandbox-safety-net + ciao-network-guard
# preloads NemoClaw checks for (see /opt/nemoclaw/src/lib/agent/runtime.ts).
#
# The fix: ensure-recovery-guards.sh copies the REAL preload files from the
# NemoClaw install into the container and patches proxy-env.sh with the
# matching NODE_OPTIONS. The substring check then passes and the gateway can
# recover with the safety net actually intact (preserving HTTP_PROXY,
# unhandled-rejection swallowing, ciao netns guard, etc.).
#
# We run ensure-recovery-guards.sh on every tick (idempotent) so a container
# restart that re-wrote proxy-env.sh without NODE_OPTIONS gets re-patched
# before the NEXT crash can happen.

TAG="[hermes-remote-watchdog]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

# Attempt to restart a dead gateway using `nemoclaw recover`. With the
# recovery guards already in place (see ensure-recovery-guards.sh) the
# NemoClaw gateway-recovery code path succeeds with the safety net intact —
# no need to remove proxy-env.sh.
recover_dead_gateway() {
  local name="$1" container="$2"
  log "gateway dead for '$name' — attempting nemoclaw recover"

  # nemoclaw lives in the nvm bin dir which is not in systemd's PATH.
  local nemoclaw_bin
  nemoclaw_bin=$(command -v nemoclaw 2>/dev/null \
    || ls /root/.nvm/versions/node/*/bin/nemoclaw 2>/dev/null | sort -t/ -k8 -V | tail -1 \
    || true)
  if [ -z "$nemoclaw_bin" ]; then
    warn "nemoclaw not found — cannot auto-recover gateway for '$name'"
    return 1
  fi

  "$nemoclaw_bin" "$name" recover 2>/dev/null || true
  sleep 8  # give the gateway time to start up

  # Verify the gateway came up
  local pid
  pid=$(find_gateway_pid "$container")
  if [ -n "$pid" ]; then
    log "gateway for '$name' recovered at PID $pid"
    return 0
  else
    warn "gateway for '$name' still dead after recover attempt"
    return 1
  fi
}

shopt -s nullglob
for f in "$ACCESS_DIR"/*.json; do
  name=$(basename "$f" .json)

  CONTAINER=$(find_sandbox_container "$name")
  if [ -z "$CONTAINER" ]; then
    log "sandbox '$name' has no running container — skipping (unexpose if deleted)"
    continue
  fi

  # Always (re)install the gateway-recovery guards so any crash AFTER this
  # tick can self-heal. Idempotent and short-circuits when already applied.
  "$SCRIPT_DIR/ensure-recovery-guards.sh" "$name" 2>/dev/null \
    || warn "ensure-recovery-guards failed for '$name'"

  # If the Hermes gateway process is dead, try to recover it before launch.sh
  # attempts to (re)launch the dashboard — launch.sh exits immediately if it
  # can't find a live gateway PID.
  if [ -z "$(find_gateway_pid "$CONTAINER")" ]; then
    recover_dead_gateway "$name" "$CONTAINER" || true
  fi

  "$SCRIPT_DIR/launch.sh" "$name" || warn "launch failed for '$name'"

  if ! systemctl is-active --quiet "hermes-remote-forward@${name}.service"; then
    log "restarting forward unit for '$name'"
    systemctl restart "hermes-remote-forward@${name}.service" 2>/dev/null \
      || warn "forward unit restart failed for '$name'"
  fi
done
