import { NextResponse } from "next/server"

type ControllerPlanRequest = {
  controllerName?: unknown
  controllerHost?: unknown
  sshTarget?: unknown
  installDir?: unknown
  repoUrl?: unknown
  dashboardPort?: unknown
  terminalPort?: unknown
  openClawDashboardUrl?: unknown
  openshellGateway?: unknown
  exposePublicly?: unknown
}

const DEFAULT_REPO_URL = process.env.OPENSHELL_CONTROL_REPO_URL || "https://github.com/NVIDIA/nemoclaw-dashboard.git"
const SAFE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const SAFE_SSH_TARGET = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+(?::[0-9]{1,5})?$/

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback
}

function numberValue(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function validateUrl(value: string, label: string) {
  try {
    const parsed = new URL(value)
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error()
    return parsed.toString()
  } catch {
    throw new Error(`${label} must be an http(s) URL`)
  }
}

function validateInstallDir(value: string) {
  if (!value || value.includes("\n") || value.includes("\0") || value.startsWith("-") || value.includes("..")) {
    throw new Error("installDir must be a safe absolute path or home-relative directory")
  }
  if (!value.startsWith("/") && !/^[a-zA-Z0-9._/-]+$/.test(value)) {
    throw new Error("installDir can only contain letters, numbers, dots, underscores, hyphens, and slashes")
  }
  return value.replace(/\/+$/, "") || "openshell-control"
}

function buildEnvBlock(params: {
  controllerName: string
  controllerHost: string
  dashboardPort: number
  terminalPort: number
  openClawDashboardUrl: string
  openshellGateway: string
  exposePublicly: boolean
}) {
  const dashboardOrigin = `http://${params.controllerHost}:${params.dashboardPort}`
  const registry = [
    {
      id: params.controllerName,
      label: `${params.controllerName} controller`,
      dashboardUrl: params.openClawDashboardUrl,
      controlUiOrigin: dashboardOrigin,
      terminalServerUrl: `http://127.0.0.1:${params.terminalPort}`,
      loopbackOnly: !params.exposePublicly,
      default: true,
    },
  ]

  return [
    `NEXT_PUBLIC_DASHBOARD_PORT=${params.dashboardPort}`,
    "NEXT_PUBLIC_API_BASE=/api",
    "NEXT_PUBLIC_ENABLE_SANDBOX_OPERATIONS=true",
    `OPENSHELL_GATEWAY=${params.openshellGateway}`,
    "OPEN_SHELL_CONTAINER=openshell-cluster-nemoclaw",
    "TERMINAL_SERVER_AUTOSTART=true",
    `TERMINAL_SERVER_PORT=${params.terminalPort}`,
    `OPENCLAW_DASHBOARD_URL=${params.openClawDashboardUrl}`,
    `OPENCLAW_INSTANCE_REGISTRY_JSON=${JSON.stringify(registry)}`,
  ].join("\n")
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as ControllerPlanRequest
    const controllerName = text(body.controllerName, "remote-controller").toLowerCase()
    if (!SAFE_NAME.test(controllerName) || controllerName.length > 63) {
      throw new Error("controllerName must be lowercase letters, numbers, and internal hyphens")
    }

    const controllerHost = text(body.controllerHost)
    if (!controllerHost) throw new Error("controllerHost is required")

    const sshTarget = text(body.sshTarget)
    if (sshTarget && !SAFE_SSH_TARGET.test(sshTarget)) {
      throw new Error("sshTarget must look like user@host or user@host:port")
    }

    const installDir = validateInstallDir(text(body.installDir, "openshell-control"))
    const repoUrl = validateUrl(text(body.repoUrl, DEFAULT_REPO_URL), "repoUrl")
    const dashboardPort = numberValue(body.dashboardPort, 3000)
    const terminalPort = numberValue(body.terminalPort, 3011)
    const openClawDashboardUrl = validateUrl(text(body.openClawDashboardUrl, "http://127.0.0.1:18789/"), "openClawDashboardUrl")
    const openshellGateway = text(body.openshellGateway, "nemoclaw")
    const exposePublicly = Boolean(body.exposePublicly)
    const envBlock = buildEnvBlock({
      controllerName,
      controllerHost,
      dashboardPort,
      terminalPort,
      openClawDashboardUrl,
      openshellGateway,
      exposePublicly,
    })

    const remoteBootstrap = [
      "set -euo pipefail",
      `INSTALL_DIR=${shellSingleQuote(installDir)}`,
      `REPO_URL=${shellSingleQuote(repoUrl)}`,
      'if ! command -v git >/dev/null 2>&1; then echo "git is required" >&2; exit 1; fi',
      'if ! command -v node >/dev/null 2>&1; then echo "Node.js 20+ is required" >&2; exit 1; fi',
      'if [ -d "$INSTALL_DIR/.git" ]; then git -C "$INSTALL_DIR" pull --ff-only; else mkdir -p "$(dirname "$INSTALL_DIR")"; git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"; fi',
      'cd "$INSTALL_DIR"',
      "./install.sh --no-build --no-audit",
      "cat > .env.controller-node <<'ENV'",
      envBlock,
      "ENV",
      "cat .env.controller-node >> .env.local",
      "npm run build",
      `echo "Controller node ready on http://${controllerHost}:${dashboardPort}"`,
    ].join("\n")

    const sshCommand = sshTarget
      ? `ssh ${sshTarget.includes(":") ? `-p ${sshTarget.split(":").pop()} ${sshTarget.split(":")[0]}` : sshTarget} 'bash -s' <<'REMOTE_CONTROLLER'\n${remoteBootstrap}\nREMOTE_CONTROLLER`
      : remoteBootstrap

    return NextResponse.json({
      ok: true,
      controller: {
        name: controllerName,
        url: `http://${controllerHost}:${dashboardPort}`,
        host: controllerHost,
        dashboardPort,
        terminalPort,
        installDir,
      },
      env: envBlock,
      commands: {
        ssh: sshCommand,
        localBootstrap: remoteBootstrap,
        start: `cd ${shellSingleQuote(installDir)} && npm run start`,
        terminal: `cd ${shellSingleQuote(installDir)} && npm run terminal-server`,
      },
      checks: [
        "OpenShell CLI is installed on the controller node and can reach the gateway.",
        `The controller can reach ${openClawDashboardUrl}.`,
        `Port ${dashboardPort} is reachable from your browser or through an SSH tunnel.`,
        `Port ${terminalPort} stays private unless you intentionally expose terminal transport.`,
      ],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build controller node plan"
    return NextResponse.json({ ok: false, error: message }, { status: 400 })
  }
}
