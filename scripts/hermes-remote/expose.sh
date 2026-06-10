#!/bin/bash
# Expose a Hermes sandbox's dashboard for the Hermes Desktop app.
#
# Usage: expose.sh <sandbox-name> [--mode desktop|web]
#
# Idempotent end-to-end setup:
#   1. deterministic host/sandbox port  21000 + hash(name) % 2000  (collision-checked)
#   2. stable per-sandbox session token (HERMES_DASHBOARD_SESSION_TOKEN)
#   3. dashboard launch inside the gateway netns        (launch.sh)
#   4. systemd-supervised `openshell forward` on the Traefik bridge IP
#   5. UFW allow for the docker networks
#   6. Traefik file-provider rule:
#        desktop mode (default): forwards ONLY /hermes/<sb>/api/* — the SPA
#          shell (which leaks the session token in its HTML) is never served
#          publicly, so the token is a real credential distributed solely via
#          the controller UI. The path intentionally bypasses Pangolin: the
#          desktop app's /api/status probe cannot follow an SSO redirect.
#        web mode: additionally forwards the SPA shell. The HTML hands the
#          session token to any fetcher, so ONLY use behind a Pangolin-gated
#          resource or on trusted networks.
#   7. watchdog timer that re-runs launch.sh + heals forwards after restarts
#   8. access record at /etc/openshell/hermes-access/<sb>.json (read by the
#      controller's /api/sandbox/<sb>/hermes-remote endpoint)
#
# Prints the access JSON on stdout when every verification passes.

TAG="[hermes-remote-expose]"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

SANDBOX="${1:-}"
[ -n "$SANDBOX" ] || die "usage: expose.sh <sandbox-name> [--mode desktop|web]"
echo "$SANDBOX" | grep -qE '^[a-z0-9][a-z0-9-]{0,62}$' || die "invalid sandbox name '$SANDBOX'"
MODE="desktop"
[ "${2:-}" = "--mode" ] && MODE="${3:-desktop}"
case "$MODE" in desktop|web) ;; *) die "invalid mode '$MODE' (desktop|web)";; esac

[ "$(id -u)" -eq 0 ] || die "must run as root"
ensure_dirs

CONTAINER=$(find_sandbox_container "$SANDBOX")
[ -n "$CONTAINER" ] || die "no running container for sandbox '$SANDBOX'"
docker exec "$CONTAINER" test -x /opt/hermes/.venv/bin/python 2>/dev/null \
  || die "'$SANDBOX' is not a Hermes sandbox (/opt/hermes missing)"

BRIDGE_IP=$(traefik_bridge_ip)
RULES_DIR=$(traefik_rules_dir)
PUBLIC_HOST=$(public_host)

# ── Port: reuse recorded port; else hash, rehashing on collision ──
PORT=$(read_access_field "$SANDBOX" port || true)
if [ -z "$PORT" ]; then
  for salt in "" 1 2 3 4 5 6 7 8 9; do
    candidate=$(sandbox_port "$SANDBOX" "$salt")
    if ! ss -lnt 2>/dev/null | awk '{print $4}' | grep -q ":${candidate}$" \
       && ! grep -l "\"port\": ${candidate}[,}]" "$ACCESS_DIR"/*.json 2>/dev/null | grep -qv "$(access_file "$SANDBOX")"; then
      PORT="$candidate"
      break
    fi
    warn "port $candidate occupied; rehashing with salt"
  done
  [ -n "$PORT" ] || die "no free port found in ${HERMES_PORT_BASE}..$(( HERMES_PORT_BASE + HERMES_PORT_RANGE - 1 ))"
fi

# ── Token: stable across restarts; reuse when present ─────────────
TOKEN=$(read_access_field "$SANDBOX" token || true)
[ -n "$TOKEN" ] || TOKEN=$(openssl rand -base64 33 | tr '+/' '-_' | tr -d '=')

PUBLIC_URL="https://${PUBLIC_HOST}/hermes/${SANDBOX}"
HERMES_VERSION=$(docker exec "$CONTAINER" /opt/hermes/.venv/bin/hermes --version 2>/dev/null | head -1 | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo unknown)

# ── Access record (written before launch.sh, which reads it) ──────
umask 077
cat > "$(access_file "$SANDBOX")" <<EOF
{
  "sandbox": "${SANDBOX}",
  "mode": "${MODE}",
  "port": ${PORT},
  "token": "${TOKEN}",
  "url": "${PUBLIC_URL}",
  "publicHost": "${PUBLIC_HOST}",
  "bridgeIp": "${BRIDGE_IP}",
  "hermesVersion": "${HERMES_VERSION}",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

# ── Dashboard ──────────────────────────────────────────────────────
"$SCRIPT_DIR/launch.sh" "$SANDBOX" || die "dashboard launch failed"

# ── systemd-supervised forward on the Traefik bridge IP ────────────
# `openshell forward` maps host:PORT -> sandbox:PORT through the OpenShell
# gateway gRPC channel; it dies when the sandbox restarts, so systemd
# Restart=always supervises it (POC: ad-hoc -d forwards die silently).
if [ ! -f "/etc/systemd/system/$FORWARD_UNIT" ]; then
  cat > "/etc/systemd/system/$FORWARD_UNIT" <<'UNIT'
[Unit]
Description=Hermes dashboard forward for sandbox %i
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
EnvironmentFile=/etc/openshell/hermes-remote/%i.env
ExecStart=/usr/bin/openshell forward start ${HERMES_FORWARD_BIND}:${HERMES_FORWARD_PORT} %i
Restart=always
RestartSec=5
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
fi
cat > "$FORWARD_ENV_DIR/${SANDBOX}.env" <<EOF
HERMES_FORWARD_BIND=${BRIDGE_IP}
HERMES_FORWARD_PORT=${PORT}
EOF
# Clear any ad-hoc forward holding the port, then hand it to systemd.
openshell forward stop "$PORT" "$SANDBOX" >/dev/null 2>&1
systemctl enable --now "hermes-remote-forward@${SANDBOX}.service" >/dev/null 2>&1
systemctl restart "hermes-remote-forward@${SANDBOX}.service"

# ── UFW ────────────────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  ufw status | grep -qE "^${PORT}/tcp\s+ALLOW\s+172\.0\.0\.0/8" \
    || ufw allow from 172.0.0.0/8 to any port "$PORT" proto tcp >/dev/null
fi

# ── Traefik rule ───────────────────────────────────────────────────
PATH_RULE="PathPrefix(\`/hermes/${SANDBOX}/api\`)"
[ "$MODE" = "web" ] && PATH_RULE="PathPrefix(\`/hermes/${SANDBOX}\`)"
cat > "$RULES_DIR/hermes-remote-${SANDBOX}.yml" <<EOF
# Managed by openshell-controller scripts/hermes-remote/expose.sh — do not edit.
# Mode: ${MODE}. This route bypasses Pangolin by design; auth is Hermes'
# session-token gate (X-Hermes-Session-Token / ?token=).
http:
  routers:
    99-hermes-remote-${SANDBOX}:
      entryPoints: [websecure]
      priority: 250
      rule: "Host(\`${PUBLIC_HOST}\`) && ${PATH_RULE}"
      service: 99-hermes-remote-${SANDBOX}-svc
      middlewares:
        - 99-hermes-remote-${SANDBOX}-strip
        - 99-hermes-remote-${SANDBOX}-prefix
      tls: { certResolver: letsencrypt }
  services:
    99-hermes-remote-${SANDBOX}-svc:
      loadBalancer:
        servers:
          - url: "http://${BRIDGE_IP}:${PORT}"
  middlewares:
    99-hermes-remote-${SANDBOX}-strip:
      stripPrefix:
        prefixes: ["/hermes/${SANDBOX}"]
    99-hermes-remote-${SANDBOX}-prefix:
      headers:
        customRequestHeaders:
          X-Forwarded-Prefix: "/hermes/${SANDBOX}"
EOF

# ── Watchdog (one unit heals every exposed sandbox) ───────────────
if [ ! -f "/etc/systemd/system/${WATCHDOG_UNIT}.timer" ]; then
  cat > "/etc/systemd/system/${WATCHDOG_UNIT}.service" <<EOF
[Unit]
Description=Hermes remote-desktop watchdog (relaunch dashboards after sandbox restarts)

[Service]
Type=oneshot
ExecStart=${SCRIPT_DIR}/watchdog.sh
EOF
  cat > "/etc/systemd/system/${WATCHDOG_UNIT}.timer" <<'EOF'
[Unit]
Description=Run hermes-remote watchdog every 2 minutes

[Timer]
OnBootSec=90
OnUnitActiveSec=120

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${WATCHDOG_UNIT}.timer" >/dev/null 2>&1
fi

# ── End-to-end verification through the public URL ─────────────────
sleep 3
code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "${PUBLIC_URL}/api/status")
[ "$code" = "200" ] || die "public ${PUBLIC_URL}/api/status returned $code (expected 200)"
code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' -H "X-Hermes-Session-Token: ${TOKEN}" "${PUBLIC_URL}/api/config")
[ "$code" = "200" ] || die "authenticated probe returned $code (expected 200) — token mismatch?"
code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' -H "X-Hermes-Session-Token: bogus" "${PUBLIC_URL}/api/config")
[ "$code" = "401" ] || die "bogus token returned $code (expected 401) — auth gate not engaged"
if [ "$MODE" = "desktop" ]; then
  # The SPA shell must NOT be reachable (it leaks the session token).
  code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "${PUBLIC_URL}/")
  [ "$code" = "404" ] || die "SPA shell reachable in desktop mode (got $code, expected 404) — token would leak"
fi

log "exposed '$SANDBOX' (${MODE}) at ${PUBLIC_URL}"
cat "$(access_file "$SANDBOX")"
