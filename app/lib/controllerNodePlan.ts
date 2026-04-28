import { randomBytes } from "node:crypto"

export type ControllerPlanRequest = {
  controllerName?: unknown
  controllerHost?: unknown
  sshTarget?: unknown
  installDir?: unknown
  repoUrl?: unknown
  dashboardPort?: unknown
  terminalPort?: unknown
  openclawUrl?: unknown
  openClawDashboardUrl?: unknown
  openshellGateway?: unknown
  parentControllerUrl?: unknown
  existingToken?: unknown
}

export type ControllerNodePlan = {
  controller: {
    name: string
    host: string
    url: string
    sshTarget: string
    installDir: string
    repoUrl: string
    parentControllerUrl: string
    dashboardPort: number
    terminalPort: number
  }
  env: string
  serviceUnit: string
  commands: {
    ssh: string
    localBootstrap: string
    start: string
    terminal: string
  }
  checks: string[]
}

const DEFAULT_REPO_URL = process.env.OPENSHELL_CONTROL_REPO_URL || "https://github.com/mmckeen-nv/openshell_controller.git"
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/i
const SAFE_HOST = /^[a-z0-9.-]+$/i
const SAFE_SSH_TARGET = /^([a-z0-9._-]+@)?[a-z0-9.-]+(:[0-9]{1,5})?$/i

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

export function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function sshBootstrapInvocation(target: string) {
  const match = target.match(/^((?:[a-z0-9._-]+@)?[a-z0-9.-]+)(?::([0-9]{1,5}))?$/i)
  if (!match) throw new Error("sshTarget must look like user@host or user@host:port")
  const [, host, targetPort] = match
  return targetPort ? `ssh -p ${targetPort} ${shellSingleQuote(host)}` : `ssh ${shellSingleQuote(host)}`
}

function validateUrl(value: string, label: string) {
  if (/^git@[a-z0-9.-]+:[a-z0-9._/-]+\.git$/i.test(value)) return value
  if (/^ssh:\/\/[^\s]+$/i.test(value)) return value
  try {
    const parsed = new URL(value)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return value
  } catch {
    // handled below
  }
  throw new Error(`${label} must be an http(s), ssh, or git SSH URL`)
}

function validateHttpUrl(value: string, label: string) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return value.replace(/\/$/, "")
  } catch {
    // handled below
  }
  throw new Error(`${label} must be an http(s) URL`)
}

function validateInstallDir(value: string) {
  if (!value || value.includes("\0") || value.includes("\n")) throw new Error("installDir is invalid")
  if (!value.startsWith("/")) throw new Error("installDir must be an absolute path")
  return value.replace(/\/$/, "")
}

function controllerToken(value: unknown) {
  const existing = text(value)
  if (existing) {
    if (!/^[a-zA-Z0-9._~:-]{20,256}$/.test(existing)) throw new Error("existingToken contains unsupported characters")
    return existing
  }
  return randomBytes(32).toString("base64url")
}

function buildEnvBlock(input: {
  controllerName: string
  parentControllerUrl: string
  token: string
  dashboardPort: number
  terminalPort: number
  openclawUrl: string
  openshellGateway: string
}) {
  const registry = JSON.stringify({
    nodes: [
      {
        id: input.controllerName,
        name: input.controllerName,
        url: `http://127.0.0.1:${input.dashboardPort}`,
        role: "controller-node",
      },
    ],
  })

  return [
    `CONTROLLER_NODE_ID=${input.controllerName}`,
    `CONTROLLER_NODE_PARENT_URL=${input.parentControllerUrl}`,
    `CONTROLLER_NODE_SHARED_SECRET=${input.token}`,
    `NEXT_PUBLIC_DASHBOARD_PORT=${input.dashboardPort}`,
    "NEXT_PUBLIC_API_BASE=",
    "NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS=true",
    `OPENSHELL_GATEWAY=${input.openshellGateway}`,
    "OPEN_SHELL_CONTAINER=openshell-control",
    "TERMINAL_SERVER_AUTOSTART=true",
    `TERMINAL_SERVER_PORT=${input.terminalPort}`,
    `OPENCLAW_DASHBOARD_URL=${input.openclawUrl}`,
    `OPENCLAW_INSTANCE_REGISTRY_JSON=${registry}`,
  ].join("\n")
}

function serviceUnit(installDir: string) {
  return `[Unit]
Description=OpenShell Controller Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${installDir}
EnvironmentFile=${installDir}/.env.local
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
`
}

export function buildControllerNodePlan(input: ControllerPlanRequest = {}): ControllerNodePlan {
  const controllerName = text(input.controllerName, "remote-controller-01").toLowerCase()
  if (!SAFE_NAME.test(controllerName)) throw new Error("controllerName must be 2-63 letters, numbers, or hyphens")

  const host = text(input.controllerHost)
  if (!host || !SAFE_HOST.test(host)) throw new Error("controllerHost must be a hostname or IP address")

  const installDir = validateInstallDir(text(input.installDir, "/opt/openshell-control"))
  const repoUrl = validateUrl(text(input.repoUrl, DEFAULT_REPO_URL), "repoUrl")
  const dashboardPort = numberValue(input.dashboardPort, 3000)
  const terminalPort = numberValue(input.terminalPort, 3011)
  const openclawUrl = validateHttpUrl(text(input.openclawUrl, text(input.openClawDashboardUrl, "http://localhost:3002")), "openclawUrl")
  const openshellGateway = text(input.openshellGateway, "local")
  if (!/^[a-z0-9._:-]+$/i.test(openshellGateway)) throw new Error("openshellGateway contains unsupported characters")
  const parentControllerUrl = validateHttpUrl(text(input.parentControllerUrl, "http://localhost:3000"), "parentControllerUrl")
  const token = controllerToken(input.existingToken)
  const sshTarget = text(input.sshTarget, host)
  if (!SAFE_SSH_TARGET.test(sshTarget)) throw new Error("sshTarget must look like user@host or user@host:port")
  const envBlock = buildEnvBlock({
    controllerName,
    parentControllerUrl,
    token,
    dashboardPort,
    terminalPort,
    openclawUrl,
    openshellGateway,
  })
  const unit = serviceUnit(installDir)
  const remoteBootstrap = `#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR=${shellSingleQuote(installDir)}
REPO_URL=${shellSingleQuote(repoUrl)}
DASHBOARD_PORT=${dashboardPort}
TERMINAL_PORT=${terminalPort}

for binary in git node npm; do
  if ! command -v "$binary" >/dev/null 2>&1; then
    echo "Missing required binary: $binary" >&2
    echo "Install Node.js 20+, npm, and git before running this bootstrap." >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$INSTALL_DIR")"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --depth=1 origin
  git -C "$INSTALL_DIR" pull --ff-only
else
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
./install.sh --no-build --no-audit

cat > .env.controller-node <<'ENV_CONTROLLER_NODE'
${envBlock}
ENV_CONTROLLER_NODE

touch .env.local
TMP_ENV="$(mktemp)"
grep -Ev '^(CONTROLLER_NODE_ID|CONTROLLER_NODE_PARENT_URL|CONTROLLER_NODE_SHARED_SECRET|NEXT_PUBLIC_DASHBOARD_PORT|NEXT_PUBLIC_API_BASE|NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS|OPENSHELL_GATEWAY|OPEN_SHELL_CONTAINER|TERMINAL_SERVER_AUTOSTART|TERMINAL_SERVER_PORT|OPENCLAW_DASHBOARD_URL|OPENCLAW_INSTANCE_REGISTRY_JSON)=' .env.local > "$TMP_ENV" || true
cat "$TMP_ENV" .env.controller-node > .env.local
rm -f "$TMP_ENV"
chmod 600 .env.local .env.controller-node

npm run build

if command -v systemctl >/dev/null 2>&1 && [ -w /etc/systemd/system ]; then
  cat > /etc/systemd/system/openshell-controller-node.service <<'SYSTEMD'
${unit}
SYSTEMD
  systemctl daemon-reload
  systemctl enable --now openshell-controller-node.service
  systemctl restart openshell-controller-node.service
else
  echo "Systemd service was not installed. Start manually with: npm run start -- --hostname 0.0.0.0 --port $DASHBOARD_PORT"
fi

echo "Controller node ready at http://${host}:$DASHBOARD_PORT"
echo "OpenShell CLI is installed in $INSTALL_DIR and can manage sandboxes reachable from this VPS."
`

  return {
    controller: {
      name: controllerName,
      host,
      url: `http://${host}:${dashboardPort}`,
      sshTarget,
      installDir,
      repoUrl,
      parentControllerUrl,
      dashboardPort,
      terminalPort,
    },
    env: envBlock,
    serviceUnit: unit,
    commands: {
      ssh: `${sshBootstrapInvocation(sshTarget)} 'bash -s' <<'REMOTE_CONTROLLER'\n${remoteBootstrap}\nREMOTE_CONTROLLER`,
      localBootstrap: remoteBootstrap,
      start: `cd ${shellSingleQuote(installDir)} && npm run start -- --hostname 0.0.0.0 --port ${dashboardPort}`,
      terminal: `TERMINAL_SERVER_PORT=${terminalPort} npm run terminal-server`,
    },
    checks: [
      `curl -fsS http://${host}:${dashboardPort}/api/controller-node/health`,
      `curl -fsS ${openclawUrl}/api/instances`,
      `ssh ${host} 'cd ${shellSingleQuote(installDir)} && npm run status'`,
    ],
  }
}
