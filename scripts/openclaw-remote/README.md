# openclaw-remote — expose an OpenClaw sandbox gateway for the mobile apps

> ⚠️ **PARKED POC (2026-06-30).** Proven working manually on a BYOVPS
> AgentGateway, but **not yet wired into the install flow**. The OpenClaw
> Android/iOS apps were just released and their remote-gateway connect form is
> still settling (they currently want **host + port**, no path). Resume when the
> app stabilises. This suite is committed so the proven mechanism isn't lost.

The OpenClaw analogue of `scripts/hermes-remote/`. It exposes each OpenClaw
sandbox's gateway (multiplexed WS + HTTP, default `:18789`, here `:18790`) so the
OpenClaw mobile apps can connect remotely with `wss://<host>:443` + the gateway
token (sent in the WS `connect` frame).

## What `expose.sh <sandbox>` does

1. Reads `gateway.port` + `gateway.auth.token` from the sandbox `openclaw.json`.
2. Allocates a **unique host port** (`23000 + hash(name) % 2000`; a separate
   range from Hermes' `21000–22999`).
3. Starts a systemd-supervised `openshell forward service --target-port <gwport>
   --local <bridge>:<hostport>` (`openclaw-remote-forward@<sb>.service`). Using
   `forward service` (not `forward start`) is what makes it **multi-sandbox
   safe** — every sandbox's gateway is on the same `:18790` in its own netns, so
   we map a unique host port → `127.0.0.1:<gwport>`.
4. `ufw allow from 172.0.0.0/8 to any port <hostport>` (without this, Traefik→host
   packets are silently dropped → a *timeout*, not a 502 — the Hermes gotcha).
5. Writes a **Host-based** Traefik rule `Host(openclaw-<sb>.<domain>)` →
   `http://<bridge>:<hostport>` on `websecure`/443. The app uses host+port only.
6. Writes an access record at `/etc/openshell/openclaw-access/<sb>.json`
   (`host`, `port` 443, `token`, `url`) for a future controller "connect mobile
   app" surface.
7. Verifies a real WSS handshake through the public URL returns `101`.

`unexpose.sh <sandbox>` reverses all of it.

## To finish productionising (when un-parked)

- **Wildcard cert via DNS-01**, not the per-subdomain HTTP-01 `letsencrypt`
  resolver here — Let's Encrypt rate-limits ~50 certs/week/domain, so many
  sandbox subdomains would fail. With a `*.<domain>` cert every subdomain is
  covered instantly.
- **A watchdog timer** (like `hermes-remote/`) if the gateway port/token can
  change across sandbox restarts; the forward itself self-heals via
  `Restart=always`.
- **Controller UI surface** + a `/api/sandbox/<id>/openclaw-remote` endpoint that
  reads the access record and shows host/port/token to the operator.
- **Wire into the deploy** (`expose.sh` invoked at sandbox-create) only once the
  app's connect form is final. If the app gains **path-based** URLs (like the
  Hermes desktop app), drop the per-sandbox subdomain entirely and use a single
  domain + `PathPrefix(/openclaw/<sb>)` + one cert — far simpler.

See manidae memories `project_openclaw_remote_gateway_parked` and
`project_hermes_remote_forward_scaling` for the full context and scaling notes.
