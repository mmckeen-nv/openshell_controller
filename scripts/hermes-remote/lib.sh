#!/bin/bash
# Shared helpers for Hermes remote-desktop exposure (multi-tenant).
# Sourced by expose.sh / unexpose.sh / launch.sh / watchdog.sh.
#
# Validated against: Hermes v0.16.0 / NemoClaw v0.0.58 / OpenShell v0.0.44
# (2026-06-10, POC on 167.233.45.113). Every environment assumption below is
# checked with a loud failure so drift surfaces in journalctl instead of 502s.

set -uo pipefail

TAG="${TAG:-[hermes-remote]}"

die() { echo "$TAG ERROR: $*" >&2; exit 1; }
warn() { echo "$TAG WARNING: $*" >&2; }
log() { echo "$TAG $*" >&2; }

ACCESS_DIR="/etc/openshell/hermes-access"
FORWARD_ENV_DIR="/etc/openshell/hermes-remote"
FORWARD_UNIT="hermes-remote-forward@.service"
WATCHDOG_UNIT="hermes-remote-watchdog"

# Port scheme: mirrors hashSandboxId in server.mjs:350 (OpenClaw uses
# 19000..20999; Hermes dashboards use 21000..22999). The hashed value is BOTH
# the in-sandbox listen port and the host bind port, because
# `openshell forward` maps host:PORT -> sandbox:PORT with no remapping.
HERMES_PORT_BASE="${HERMES_DASHBOARD_PORT_BASE:-21000}"
HERMES_PORT_RANGE="${HERMES_DASHBOARD_PORT_RANGE:-2000}"

# JS: hash = ((hash << 5) - hash + charCode) | 0  ==  (hash * 31 + c) as int32
hash_sandbox_id() {
  local s="$1" h=0 i c
  for ((i = 0; i < ${#s}; i++)); do
    printf -v c '%d' "'${s:$i:1}"
    h=$(( (h * 31 + c) & 0xFFFFFFFF ))
  done
  # reinterpret as signed 32-bit, then abs()
  if (( h >= 2147483648 )); then h=$(( h - 4294967296 )); fi
  echo $(( h < 0 ? -h : h ))
}

sandbox_port() {
  local name="$1" salt="${2:-}"
  echo $(( HERMES_PORT_BASE + $(hash_sandbox_id "${name}${salt}") % HERMES_PORT_RANGE ))
}

# ── Discovery helpers (no hardcoded IPs/paths — the POC was burned by both) ──

find_sandbox_container() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep "^openshell-${name}-" | head -1
}

find_gateway_pid() {
  local container="$1"
  docker exec "$container" pgrep -f 'hermes gateway run' 2>/dev/null | head -1
}

find_traefik_container() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -i traefik | head -1
}

# The bridge IP Traefik can reach the host on. NOT docker0: in the Komodo
# stack Traefik sits on a compose bridge and host.docker.internal does not
# resolve. We bind tunnels on Traefik's default-gateway IP.
traefik_bridge_ip() {
  local tc ip
  tc=$(find_traefik_container) || true
  [ -n "$tc" ] || { warn "no traefik container found; falling back to 172.18.0.1"; echo "172.18.0.1"; return; }
  ip=$(docker inspect "$tc" --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{"\n"}}{{end}}' 2>/dev/null | grep -v '^$' | head -1)
  [ -n "$ip" ] || { warn "could not read traefik gateway IP; falling back to 172.18.0.1"; ip="172.18.0.1"; }
  echo "$ip"
}

traefik_rules_dir() {
  local d
  d=$(ls -d /etc/komodo/stacks/*/config/traefik/rules 2>/dev/null | head -1)
  [ -n "$d" ] || die "no Komodo traefik rules dir found under /etc/komodo/stacks/*/config/traefik/rules"
  echo "$d"
}

# Public hostname for the controller (carries the TLS cert we piggyback on).
# Priority: explicit env > controller .env.local MCPAUTH_CALLBACK_URL host.
public_host() {
  if [ -n "${HERMES_REMOTE_PUBLIC_HOST:-}" ]; then
    echo "$HERMES_REMOTE_PUBLIC_HOST"
    return
  fi
  local env_file="${CONTROLLER_ENV_FILE:-/opt/openshell-controller/.env.local}" url host
  [ -f "$env_file" ] || die "controller env file not found at $env_file and HERMES_REMOTE_PUBLIC_HOST not set"
  url=$(grep -E '^(OAUTH|MCPAUTH|CF_AUTH)_CALLBACK_URL=' "$env_file" | head -1 | cut -d= -f2-)
  host=$(echo "$url" | sed -E 's#^https?://([^/]+)/.*#\1#')
  [ -n "$host" ] || die "could not derive public host from $env_file; set HERMES_REMOTE_PUBLIC_HOST"
  echo "$host"
}

access_file() { echo "$ACCESS_DIR/$1.json"; }

read_access_field() {
  local name="$1" field="$2" f
  f=$(access_file "$name")
  [ -f "$f" ] || return 1
  python3 -c "import json,sys; print(json.load(open('$f')).get('$field',''))" 2>/dev/null
}

ensure_dirs() {
  mkdir -p "$ACCESS_DIR" "$FORWARD_ENV_DIR"
  chmod 700 "$ACCESS_DIR" "$FORWARD_ENV_DIR"
}

# Run a command inside the sandbox gateway netns as the sandbox user, with the
# runtime env (proxy, CA bundle, HERMES_HOME) sourced. The dashboard MUST live
# in the gateway netns: inference.local only resolves there.
nsenter_sandbox() {
  local container="$1" gw_pid="$2"
  shift 2
  docker exec --privileged "$container" nsenter -t "$gw_pid" -n -- "$@"
}
