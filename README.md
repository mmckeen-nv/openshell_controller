
# OpenShell Control

THIS IS VERSION LOCKED TO OpenShell v0.0.26 and NemoClaw v0.0.15.

OpenShell Control is a local, development-stage dashboard for operating OpenShell sandboxes and their OpenClaw gateway dashboards.

It is currently built for active development and lab use. It includes a simple password gate, but it is not a hardened production control plane yet.

## Current Status

- Development software. Expect fast-moving APIs and sharp edges.
- Designed to run near the OpenShell gateway host.
- Uses local shell/CLI access for sandbox lifecycle, network policy grants, file transfer, and OpenClaw dashboard proxying.
- Authentication is intentionally simple so a future dev team can replace it with a real identity provider.

## Features

- View live OpenShell sandbox inventory.
- Create, destroy, and restart sandboxes.
- Launch a sandbox-specific OpenClaw Gateway Dashboard through the local proxy.
- Approve or reject pending OpenShell network permission requests.
- Configure per-sandbox inference routes for Ollama, NIM, vLLM, and external endpoints.
- Poll Ollama for available models.
- Search the official MCP Registry, install MCP server definitions, and manage preconfigured/custom MCP servers.
- Enforce per-sandbox MCP access through a control-plane broker so sandboxes only see allowed capabilities.
- Upload files into sandboxes and download files back out.
- Open an operator terminal for the selected sandbox.
- Simple local login, setup account, forgot password, and recovery token flow.

<img width="1719" height="1185" alt="Screenshot 2026-04-27 at 3 40 27 PM" src="https://github.com/user-attachments/assets/c34c5211-aa26-4aa5-a1f8-3256bb78bdce" />

<img width="1717" height="1197" alt="Screenshot 2026-04-27 at 3 41 01 PM" src="https://github.com/user-attachments/assets/206def4d-edf1-46b3-8e00-ef24dec0d18d" />

<img width="1730" height="1183" alt="Screenshot 2026-04-27 at 3 41 12 PM" src="https://github.com/user-attachments/assets/67a0de93-e68a-48dc-845b-356baaa748db" />

<img width="1720" height="1181" alt="Screenshot 2026-04-27 at 3 41 33 PM" src="https://github.com/user-attachments/assets/23af9aac-6be3-453e-9370-c56377ce5ba2" />

<img width="1712" height="1180" alt="Screenshot 2026-04-27 at 3 41 49 PM" src="https://github.com/user-attachments/assets/2e5ce26b-3a82-43f2-b020-257d0b027a8a" />

<img width="1720" height="1185" alt="Screenshot 2026-04-27 at 3 42 09 PM" src="https://github.com/user-attachments/assets/5a573333-ffc3-49b6-9baa-2829b9949c0b" />

<img width="2117" height="1873" alt="Screenshot 2026-04-27 at 3 42 37 PM" src="https://github.com/user-attachments/assets/405ae79c-59e9-4c71-afb7-779eccb7ece7" />


## Version Requirements

Tested on the current development host with:

- Ubuntu/Linux host
- Node.js `v22.22.2`
- npm `10.9.7`
- Docker `29.1.3`
- OpenShell CLI `0.0.24`
- OpenShell cluster image `ghcr.io/nvidia/openshell/cluster:0.0.24`

Minimum expected versions:

- Node.js `20+`
- npm `10+`
- Docker `24+`
- OpenShell CLI and gateway compatible with OpenShell `0.0.24`

The app uses Next.js `14.2.35`, React `18.3.1`, TypeScript, Tailwind CSS, `ws`, `node-pty`, and the official MCP TypeScript SDK.

## Prerequisites

Install and verify:

```bash
node -v
npm -v
docker ps
openshell --version
```

Optional, but useful for stdio MCP servers installed through the broker:

```bash
npx --version
uvx --version
```

OpenShell must already be installed and able to reach its gateway. On this host the active gateway metadata lives under:

```bash
~/.config/openshell/gateways/
```

The installer does not create an OpenShell gateway for you. Start or connect OpenShell first, then install this dashboard.

## Installer

From the repository root:

```bash
./install.sh
```

The installer:

- checks Node, npm, Docker, OpenShell CLI availability, sandbox inventory reachability, and default port occupancy;
- installs or verifies the MCP package runners used by bundled stdio servers: `npx` and `uvx`;
- installs npm dependencies with `npm ci` when `package-lock.json` exists;
- runs a non-blocking `npm audit` summary;
- creates `.env.local` if needed;
- generates a local dashboard password, signing secret, and recovery token if they are missing;
- adds MCP broker defaults for token TTL and request timeout;
- runs `npm run build` as a verification step.

It refuses to run as root unless `--allow-root` is supplied. It does not install or manage a systemd service.

Options:

```bash
./install.sh --no-build
./install.sh --no-audit
./install.sh --clean-next
./install.sh --allow-root
./install.sh --start
./install.sh --help
```

After install, read the generated local password from:

```bash
grep OPENSHELL_CONTROL_PASSWORD .env.local
```

## Run

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Default ports:

- `3000`: dashboard HTTP server
- `3001`: OpenClaw dashboard websocket sidecar
- `3011`: operator terminal upstream

## Authentication

This project currently uses a simple local password and signed HTTP-only cookie.

Configuration keys:

```bash
OPENSHELL_CONTROL_PASSWORD=...
OPENSHELL_CONTROL_AUTH_SECRET=...
OPENSHELL_CONTROL_RECOVERY_TOKEN=...
```

Pages:

- `/login`
- `/setup-account`
- `/forgot-password`

There is no email sender. Forgot-password uses `OPENSHELL_CONTROL_RECOVERY_TOKEN` from `.env.local`, which means it is a host-admin recovery flow. Anyone who can read `.env.local` can reset the dashboard password.

After changing `.env.local`, restart the server:

```bash
pkill -f 'node server.mjs|npm run dev' || true
npm run dev
```

## OpenShell And OpenClaw Notes

The dashboard shells out to the OpenShell CLI for several operations:

- `openshell list`
- `openshell sandbox exec`
- `openshell sandbox delete`
- `openshell rule get`
- `openshell rule approve`
- `openshell rule reject`

OpenClaw dashboard access is loopback-only inside the host/sandbox context, so the UI uses local proxy routes:

- `/api/openshell/dashboard/proxy`
- `/api/openshell/instances/[instanceId]/dashboard/proxy`

The custom server in `server.mjs` also handles websocket upgrades for:

- operator terminal websocket traffic;
- OpenClaw dashboard websocket traffic.

Those upgrade paths are protected by the same auth cookie as the HTTP routes.

## Remote Controller Nodes

The Wizards page includes **Spawn a Controller Node** for preparing a small OpenShell Control install on another VPS. This is intended for topologies where the browser-facing dashboard and the OpenShell gateway/sandbox hosts are not the same machine.

The wizard supports two deployment paths:

- **Manual Deploy** generates an SSH/bootstrap script, controller `.env` block, parent-controller URL, node shared secret, OpenShell/OpenClaw routing settings, and readiness checks.
- **Autodeploy** connects to the remote host over SSH using a one-time password supplied in the browser, optionally runs the bootstrap with sudo, installs a systemd service when available, and returns bounded stdout/stderr plus the observed host-key fingerprint.

Autodeploy does not store the SSH password or write it into generated scripts. For host-key safety, provide an expected SHA256 host-key fingerprint or explicitly select trust-on-first-deploy on a trusted management network. After the controller is running, use its local OpenShell CLI context to manage the sandboxes reachable from that VPS.

## Inference Endpoints

Inference endpoint configuration is development-stage.

The UI supports per-sandbox route profiles and can apply them live to OpenClaw where possible. Depending on the sandbox and provider, changes may require a sandbox restart to fully take effect inside the container.

Supported provider categories in the UI:

- Ollama
- NVIDIA NIM
- vLLM
- external HTTP-compatible endpoints

## MCP Access Broker

OpenShell Control can install and broker MCP servers without disclosing the full MCP inventory to sandboxes.

The MCP page supports:

- registry search with paged results;
- preconfigured servers, including Blender MCP;
- custom stdio or HTTP MCP servers;
- global enable/disable state;
- per-sandbox `Disabled`, `Allow All`, and `Allow Only` access policy.

The sandbox page shows an MCP indicator on each sandbox card. A sandbox lights up when at least one MCP server is allowed by policy.

For sandbox handoff, OpenShell Control writes:

```text
/sandbox/openshell_control_mcp.md
```

That file contains only the MCP broker endpoints and a sandbox-scoped token. It does not list denied servers, launch commands, credentials, or registry metadata. The broker validates the token and enforces access policy on every capabilities and tool-call request.

Broker endpoints:

```text
/api/mcp/broker/capabilities
/api/mcp/broker/call
```

Broker configuration keys:

```bash
MCP_BROKER_TOKEN_TTL_HOURS=168
MCP_BROKER_REQUEST_TIMEOUT_MS=45000
OPENSHELL_CONTROL_MCP_BROKER_URL=http://localhost:3000/api/mcp/broker
```

`OPENSHELL_CONTROL_MCP_BROKER_URL` is optional. Set it only when you need to override discovery. By default the dashboard discovers the active OpenShell Docker gateway and the selected sandbox's proxy environment before writing `/sandbox/openshell_control_mcp.md`.

Stdio MCP servers run on the control host. The installer verifies `npx`, creates or reuses a Python virtual environment, installs `uvx` there, and persists that venv path in `.env.local` so the MCP broker can launch `uvx` servers later. Custom MCP server launch commands, such as `node` or `python`, must also be available to the dashboard process.

## File Transfer

The file transfer UI is scoped to safe sandbox paths:

- `/sandbox`
- `/tmp`

The default max transfer size is `128 MiB`. Override with:

```bash
SANDBOX_FILE_TRANSFER_MAX_BYTES=134217728
```

## Development Commands

```bash
npm run dev
npm run lint
npx tsc --noEmit
npm run build
```

After running `npm run build` during development, restart cleanly:

```bash
pkill -f 'node server.mjs|npm run dev' || true
rm -rf .next
npm run dev
```

## Configuration

Copy or edit `.env.local`:

```bash
cp .env.example .env.local
```

Common keys:

```bash
NEXT_PUBLIC_DASHBOARD_PORT=3000
NEXT_PUBLIC_API_BASE=/api
NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS=true
OPEN_SHELL_CONTAINER=openshell-cluster-nemoclaw
OPENSHELL_GATEWAY=nemoclaw
OPENSHELL_CONTROL_PASSWORD=change-this-password
OPENSHELL_CONTROL_AUTH_SECRET=change-this-random-secret
OPENSHELL_CONTROL_RECOVERY_TOKEN=change-this-recovery-token
MCP_BROKER_TOKEN_TTL_HOURS=168
MCP_BROKER_REQUEST_TIMEOUT_MS=45000
```

## Security Limitations

This is not production hardened.

Known limitations:

- single shared local password;
- no user accounts or roles;
- no email reset flow;
- no rate limiting;
- no audit log persistence beyond process/container logs;
- local recovery token can reset the password;
- assumes a trusted operator host and trusted local filesystem.
- MCP stdio servers run as child processes on the control host; only install trusted MCP servers.
- MCP broker tokens grant sandbox-scoped access until expiry or rotation.

Before exposing this outside a trusted lab network, replace auth with a real identity provider, add role-based access control, add audit logging, use TLS, and review every shell-out path.

## Troubleshooting

Check OpenShell:

```bash
openshell --version
openshell list
docker ps | grep openshell
```

Check auth:

```bash
grep OPENSHELL_CONTROL_PASSWORD .env.local
grep OPENSHELL_CONTROL_RECOVERY_TOKEN .env.local
```

Check dashboard:

```bash
npm run lint
npx tsc --noEmit
npm run build
```

If the UI behaves oddly after a production build:

```bash
pkill -f 'node server.mjs|npm run dev' || true
rm -rf .next
npm run dev
```

## License

Internal development prototype. Add the appropriate license before distribution.
