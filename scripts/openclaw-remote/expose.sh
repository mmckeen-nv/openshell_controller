#!/bin/bash
# Expose an OpenClaw sandbox's gateway for the OpenClaw mobile (Android/iOS) apps.
#
# ⚠️  PARKED POC (2026-06-30) — proven working manually on a BYOVPS AgentGateway,
#     but NOT yet wired into the install flow. Resume when the OpenClaw app's
#     remote-gateway connect form stabilises. See manidae memories
#     project_openclaw_remote_gateway_parked + project_hermes_remote_forward_scaling.
#
# Mirrors scripts/hermes-remote/expose.sh, with three differences that make it
# simpler than the Hermes desktop exposure:
#   * the OpenClaw gateway is ALREADY running on 0.0.0.0:<gwport> in the sandbox
#     gateway netns — there is no dashboard-launch step (Hermes needed launch.sh).
#   * auth is a shared-secret token sent in the WS `connect` frame, NOT embedded
#     in any served HTML — so there is no SPA token-leak and no desktop/web mode
#     split; we expose the whole gateway.
#   * the OpenClaw app wants host+port (no path), so we publish a HOST-based
#     Traefik route on a per-sandbox subdomain (openclaw-<sb>.<domain>) on :443,
#     not a path-prefix. MULTI-SANDBOX SAFE: each sandbox gets a unique HASHED
#     host port via `openshell forward service --local`, forwarded to its
#     gateway 127.0.0.1:<gwport>. The app only ever sees the subdomain on :443.
#
# Pieces (idempotent):
#   1. gateway port + shared-secret token read from the sandbox's openclaw.json
#   2. unique host port (23000 + hash(name) % 2000; separate range from Hermes
#      21000-22999 so a Hermes and an OpenClaw sandbox never collide on the host)
#   3. systemd-supervised `openshell forward service` (openclaw-remote-forward@)
#   4. UFW allow from the docker bridge to that host port (the Hermes gotcha: a
#      timeout, not a 502, when this is missing — Traefik->host packets dropped)
#   5. Host-based Traefik file-provider rule + access record (read by the
#      controller's "connect mobile app" surface, to-be-built)
#   6. end-to-end WSS 101 verification through the public URL
#
# SCALING (see memory project_hermes_remote_forward_scaling): one persistent
# gRPC tunnel + ~30-40 MB RSS per exposed sandbox, all multiplexed through the
# single OpenShell gateway. For many sandboxes use a WILDCARD cert via DNS-01
# (NOT the per-subdomain HTTP-01 letsencrypt resolver below — LE rate limits),
# and consider lazy/on-demand forwards. The StartLimit below stops an
# unrecoverable sandbox from hammering the gateway / flooding the journal.

TAG="[openclaw-remote-expose]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the agent-agnostic helpers (die/log/warn, find_sandbox_container,
# traefik_bridge_ip, traefik_rules_dir, public_host, hash_sandbox_id).
# shellcheck source=../hermes-remote/lib.sh
source "$SCRIPT_DIR/../hermes-remote/lib.sh"

# OpenClaw-specific paths + a distinct host-port range from Hermes.
ACCESS_DIR="/etc/openshell/openclaw-access"
FORWARD_ENV_DIR="/etc/openshell/openclaw-remote"
OC_PORT_BASE="${OPENCLAW_REMOTE_PORT_BASE:-23000}"
OC_PORT_RANGE="${OPENCLAW_REMOTE_PORT_RANGE:-2000}"
access_file() { echo "$ACCESS_DIR/$1.json"; }
oc_port() { echo $(( OC_PORT_BASE + $(hash_sandbox_id "${1}${2:-}") % OC_PORT_RANGE )); }

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: expose.sh <sandbox-name>"
echo "$SANDBOX" | grep -qE '^[a-z0-9][a-z0-9-]{0,62}$' || die "invalid sandbox name '$SANDBOX'"
[ "$(id -u)" -eq 0 ] || die "must run as root"
mkdir -p "$ACCESS_DIR" "$FORWARD_ENV_DIR"; chmod 700 "$ACCESS_DIR" "$FORWARD_ENV_DIR"

CONTAINER=$(find_sandbox_container "$SANDBOX")
[ -n "$CONTAINER" ] || die "no running container for sandbox '$SANDBOX'"
docker exec "$CONTAINER" test -f /sandbox/.openclaw/openclaw.json 2>/dev/null \
  || die "'$SANDBOX' is not an OpenClaw sandbox (/sandbox/.openclaw/openclaw.json missing)"

# ── gateway port + token from openclaw.json ────────────────────────
GWPORT=$(docker exec "$CONTAINER" python3 -c \
  "import json;print(json.load(open('/sandbox/.openclaw/openclaw.json')).get('gateway',{}).get('port') or 18789)" 2>/dev/null)
TOKEN=$(docker exec "$CONTAINER" python3 -c \
  "import json;print(json.load(open('/sandbox/.openclaw/openclaw.json')).get('gateway',{}).get('auth',{}).get('token') or '')" 2>/dev/null)
echo "$GWPORT" | grep -qE '^[0-9]+$' || die "could not read gateway.port from openclaw.json (got '$GWPORT')"
[ -n "$TOKEN" ] || die "gateway.auth.token is empty — the OpenClaw gateway has no shared secret to authenticate with"

# ── unique host port: reuse recorded port, else hash + rehash on collision ──
PORT=""
[ -f "$(access_file "$SANDBOX")" ] && PORT=$(grep -oE '"hostPort": *[0-9]+' "$(access_file "$SANDBOX")" | grep -oE '[0-9]+' | head -1)
if [ -z "$PORT" ]; then
  for salt in "" 1 2 3 4 5 6 7 8 9; do
    candidate=$(oc_port "$SANDBOX" "$salt")
    if ! ss -lnt 2>/dev/null | awk '{print $4}' | grep -q ":${candidate}$" \
       && ! grep -ls "\"hostPort\": *${candidate}\b" "$ACCESS_DIR"/*.json 2>/dev/null | grep -qv "$(access_file "$SANDBOX")"; then
      PORT="$candidate"; break
    fi
  done
fi
[ -n "$PORT" ] || die "could not allocate a free host port in ${OC_PORT_BASE}-$((OC_PORT_BASE + OC_PORT_RANGE - 1))"

BRIDGE_IP=$(traefik_bridge_ip)
RULES_DIR=$(traefik_rules_dir)
# openclaw-<sb> on the BASE domain (strip the controller's first label):
#   openshell-controller.contextware.ai -> contextware.ai -> openclaw-<sb>.contextware.ai
BASE_DOMAIN=$(public_host | sed -E 's/^[^.]+\.//')
SUBHOST="openclaw-${SANDBOX}.${BASE_DOMAIN}"
PUBLIC_URL="wss://${SUBHOST}"

# ── systemd-supervised forward (forward service maps host:HP -> sandbox:GWPORT) ──
FORWARD_UNIT="openclaw-remote-forward@.service"
if [ ! -f "/etc/systemd/system/$FORWARD_UNIT" ]; then
  cat > "/etc/systemd/system/$FORWARD_UNIT" <<'UNIT'
[Unit]
Description=OpenClaw gateway forward for sandbox %i
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
Environment=OPENSHELL_GATEWAY=nemoclaw
EnvironmentFile=/etc/openshell/openclaw-remote/%i.env
ExecStart=/usr/bin/openshell forward service --target-host 127.0.0.1 --target-port ${OPENCLAW_GW_PORT} --local ${OPENCLAW_FORWARD_BIND}:${OPENCLAW_FORWARD_PORT} %i
Restart=always
RestartSec=30
# Rate-limit restarts: an unrecoverable sandbox must not hammer the single
# OpenShell gateway or flood the journal indefinitely (see scaling memory).
StartLimitIntervalSec=300
StartLimitBurst=5
# openshell forward is a long-lived tunnel that accrues FDs; 65536 = years.
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
fi
cat > "$FORWARD_ENV_DIR/${SANDBOX}.env" <<EOF
OPENCLAW_FORWARD_BIND=${BRIDGE_IP}
OPENCLAW_FORWARD_PORT=${PORT}
OPENCLAW_GW_PORT=${GWPORT}
EOF
systemctl enable --now "openclaw-remote-forward@${SANDBOX}.service" >/dev/null 2>&1
systemctl restart "openclaw-remote-forward@${SANDBOX}.service"

# ── UFW: open the host port for the docker bridge (Traefik) ─────────
UFW=/usr/sbin/ufw
if [ -x "$UFW" ] && "$UFW" status 2>/dev/null | grep -q '^Status: active'; then
  "$UFW" allow from 172.0.0.0/8 to any port "$PORT" proto tcp >/dev/null 2>&1 || true
fi

# ── Host-based Traefik rule (per-sandbox subdomain on :443) ─────────
cat > "$RULES_DIR/openclaw-remote-${SANDBOX}.yml" <<EOF
# Managed by openshell-controller scripts/openclaw-remote/expose.sh — do not edit.
# Host-based route for the OpenClaw mobile app: wss://${SUBHOST} (:443) -> gateway.
# Auth = the OpenClaw gateway shared-secret token, sent by the app in the WS
# `connect` frame (NOT in the URL/HTML), so this route can be public.
# NOTE: certResolver letsencrypt uses HTTP-01 per subdomain — switch to a
# wildcard DNS-01 cert before exposing many sandboxes (LE rate limits).
http:
  routers:
    97-openclaw-remote-${SANDBOX}:
      entryPoints: [websecure]
      priority: 260
      rule: "Host(\`${SUBHOST}\`)"
      service: 97-openclaw-remote-${SANDBOX}-svc
      tls: { certResolver: letsencrypt }
  services:
    97-openclaw-remote-${SANDBOX}-svc:
      loadBalancer:
        servers:
          - url: "http://${BRIDGE_IP}:${PORT}"
EOF

# ── access record (read by the controller "connect mobile app" surface) ──
cat > "$(access_file "$SANDBOX")" <<EOF
{
  "sandbox": "${SANDBOX}",
  "gatewayPort": ${GWPORT},
  "hostPort": ${PORT},
  "token": "${TOKEN}",
  "host": "${SUBHOST}",
  "port": 443,
  "url": "${PUBLIC_URL}",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
chmod 600 "$(access_file "$SANDBOX")"

# ── end-to-end WSS verification (handshake should switch protocols) ──
sleep 4
code=$(python3 - "$SUBHOST" <<'PY'
import socket, ssl, sys
h = sys.argv[1]
try:
    ctx = ssl._create_unverified_context()
    s = ctx.wrap_socket(socket.create_connection(("127.0.0.1", 443), timeout=12), server_hostname=h)
    s.sendall((f"GET / HTTP/1.1\r\nHost: {h}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    line = s.recv(120).decode("latin1").splitlines()[0]
    print("101" if "101" in line else "FAIL:" + line)
except Exception as e:
    print("ERR:" + str(e))
PY
)
[ "$code" = "101" ] || warn "WSS verification did not return 101 (got: $code) — check cert issuance / forward / UFW"

log "exposed OpenClaw '$SANDBOX' at ${PUBLIC_URL} (host ${SUBHOST}, port 443; token in $(access_file "$SANDBOX"))"
cat "$(access_file "$SANDBOX")"
