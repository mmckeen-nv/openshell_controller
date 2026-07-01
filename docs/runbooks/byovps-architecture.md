# Runbook — BYOVPS vs cloud VPS architecture differences

> Indexed from CLAUDE.md §4 (Runbooks index). Reach for this when a
> script works on a cloud VPS but breaks on a BYOVPS (or vice versa),
> or when a controller / sandbox interaction is degrading after a
> system event (unattended upgrade, gateway restart, etc.).

## Traefik network mode

**Cloud VPS:** Traefik has its own Docker network entry →
`docker inspect traefik` returns `.NetworkSettings.Networks` with a
populated `.Gateway` field.

**BYOVPS (Komodo stack):** Traefik runs with `--network container:gerbil`
so it shares Gerbil's network namespace. Its own `NetworkSettings.Networks`
is **empty**. `traefik_bridge_ip()` in `scripts/hermes-remote/lib.sh`
detects this by reading `HostConfig.NetworkMode` — if it starts with
`container:`, it inspects the referenced container (Gerbil) instead.
Never assume `docker inspect traefik` has network data on a BYOVPS.

## hermes gateway process name

Older NemoClaw base images: `hermes` is the Python entry-point.
Cmdline: `/opt/hermes/.venv/bin/python /usr/local/bin/hermes gateway run`

Newer base images (≥ v0.16 era): `hermes` is a bash wrapper that
`exec`s `hermes.real`. Cmdline:
`/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway run`

`pgrep -f 'hermes gateway run'` misses the newer form. Always use:
`pgrep -f 'hermes[^ ]* gateway run'` (in `find_gateway_pid()` in
`scripts/hermes-remote/lib.sh`).

## Hermes first sandbox creation time

The first Hermes sandbox on a fresh BYOVPS takes **7–10 minutes** —
Docker builds the full Hermes base image from scratch. The browser
HTTP request times out and the UI shows "Sandbox creation started…"
with no further update. **This is normal.** The creation completes in
the background. Refresh the sandbox list after ~10 minutes and the
sandbox will be Ready. Subsequent creations are fast (layers cached).

## openshell forward "sandbox is not ready"

On BYOVPS, `openshell-gateway-ensure-mtls.sh` runs as ExecStartPre
every time the controller starts. If mTLS is re-armed after a sandbox
was created in plaintext era (e.g. after a controller update), the
forward fails with `FailedPrecondition: sandbox is not ready`. Only
fix: recreate the sandbox.

After NemoClaw onboard, the gateway runs in plaintext with
`OPENSHELL_DISABLE_GATEWAY_AUTH=true`. The ensure-mtls script detects
the mismatch by checking the CLI **registration URL** (https:// vs
http://), not gateway.env flags — because NVIDIA's install.sh sets
the same flags.

Since 2026-06-11 the script refuses to flip while `openshell-*`
containers are running — the flip used to silently brick every live
sandbox. It also now registers the CLI to **match the gateway's actual
scheme** (http:// while plaintext is deferred, https:// otherwise).
The old version always registered https://, which combined with a
deferred flip left the CLI speaking TLS to a plaintext gateway —
every `openshell` command then fails with `transport error: received
corrupt message of type InvalidContentType` ("Inventory Unavailable"
in the UI). If you ever see that error, check `gateway.env`
`OPENSHELL_DISABLE_TLS` vs `openshell gateway list`'s scheme;
re-register to match.

## needrestart vs the controller (incident 2026-06-11)

Ubuntu's `unattended-upgrades` + `needrestart` restarts every service
linked against an upgraded library — **once per upgraded package**. A
systemd/libssl upgrade restarted `openshell-controller` 5+ times in
60 s, tripping `StartLimitBurst=5` and leaving the service permanently
`failed` (and the restarts triggered the ensure-mtls flip that bricked
the sandboxes above). Every controller VPS needs:

```bash
cat > /etc/needrestart/conf.d/openshell-controller.conf <<'EOF'
$nrconf{override_rc}{qr(^openshell-controller\.service$)} = 0;
EOF
```

`scripts/setup/install-production.sh` writes this file automatically;
the entry is here for awareness when triaging a "failed" controller.

After an unattended upgrade, restart the controller manually
(`systemctl restart openshell-controller`). Recovery from the failed
state is `systemctl reset-failed openshell-controller && systemctl
start openshell-controller`.

## Ollama bootstrap lives in manidae-cloud, not here

When a fresh-deploy sandbox-create fails with "Failed to apply Ollama
systemd loopback override" — or a stray root-owned `ollama serve`
holds port 11434 — the bug is in the user-data, not the controller.
We tried adding a controller-side preflight shim (commit `b9f7fce`,
reverted in `0c7e7bf`) and explicitly rejected it: the controller
doesn't own ollama lifecycle. Fix it at source:

| Deploy path | Source-of-truth file |
|---|---|
| Cloud (Hetzner, Linode, Vultr, GCE) | `manidae-cloud/backend/app/core/deployment/terraform_templates/includes/startup_ollama.sh.j2` |
| BYOVPS phase-2 | `manidae-cloud/backend/app/core/deployment/byovps_bootstrap.py` (`ollama_install_block` lines ~188-271) |

Both must follow the same pattern: pkill any orphan `ollama serve`
(matches `^/usr/local/bin/ollama serve` and `^/usr/bin/ollama serve`),
write `override.conf` + `kill-stale-proxy.conf` drop-ins, then
`systemctl daemon-reload && systemctl enable ollama && systemctl
restart ollama || true`. **Never** `OLLAMA_HOST=… ollama serve &`
directly — that creates a root-owned orphan whose models live under
`/root/.ollama/` (invisible to the daemon's `ollama` user) and whose
process holds the port so `nemoclaw onboard`'s later restart can't
bind.

Regression tests:
`manidae-cloud/backend/tests/test_startup_ollama_template.py` (cloud)
and `test_byovps_bootstrap.py::test_ollama_install_kills_orphan_serve_before_systemctl_restart`
(BYOVPS) lock the orphan-kill-before-restart ordering on both paths.
