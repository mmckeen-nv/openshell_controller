"use client"

import { useEffect, useMemo, useState } from "react"
import type { SandboxInventoryItem } from "../hooks/useSandboxInventory"

type BlueprintOption = {
  id: string
  label: string
  description: string
  supportsTailscale?: boolean
}

type WizardStep = "source" | "target" | "options" | "review" | "run"

type ControllerPlan = {
  controller: {
    name: string
    url: string
    host: string
    dashboardPort: number
    terminalPort: number
    installDir: string
  }
  env: string
  commands: {
    ssh: string
    localBootstrap: string
    start: string
    terminal: string
  }
  checks: string[]
}

const steps: Array<{ key: WizardStep; label: string }> = [
  { key: "source", label: "Source" },
  { key: "target", label: "Target" },
  { key: "options", label: "Options" },
  { key: "review", label: "Review" },
  { key: "run", label: "Run" },
]

function contentDispositionFileName(value: string | null, fallback: string) {
  const header = value || ""
  return decodeURIComponent(header.match(/filename\*=UTF-8''([^;]+)/)?.[1] || "")
    || header.match(/filename="([^"]+)"/)?.[1]
    || fallback
}

function defaultCloneName(source?: SandboxInventoryItem) {
  if (!source) return ""
  return `${source.name.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")}-clone`.slice(0, 63)
}

export default function WizardPanel({
  sandboxes,
  onInventoryRefresh,
}: {
  sandboxes: SandboxInventoryItem[]
  onInventoryRefresh: () => Promise<SandboxInventoryItem[]>
}) {
  const [activeStep, setActiveStep] = useState<WizardStep>("source")
  const [sourceSandboxId, setSourceSandboxId] = useState("")
  const [targetName, setTargetName] = useState("")
  const [blueprints, setBlueprints] = useState<BlueprintOption[]>([])
  const [selectedBlueprint, setSelectedBlueprint] = useState("custom-sandbox")
  const [enableTailscale, setEnableTailscale] = useState(false)
  const [backupPath, setBackupPath] = useState("/sandbox")
  const [restorePath, setRestorePath] = useState("/sandbox")
  const [replaceTarget, setReplaceTarget] = useState(true)
  const [running, setRunning] = useState(false)
  const [message, setMessage] = useState("")
  const [runLog, setRunLog] = useState<string[]>([])
  const [controllerName, setControllerName] = useState("remote-controller")
  const [controllerHost, setControllerHost] = useState("")
  const [sshTarget, setSshTarget] = useState("")
  const [installDir, setInstallDir] = useState("openshell-control")
  const [repoUrl, setRepoUrl] = useState("https://github.com/NVIDIA/nemoclaw-dashboard.git")
  const [dashboardPort, setDashboardPort] = useState("3000")
  const [terminalPort, setTerminalPort] = useState("3011")
  const [openClawDashboardUrl, setOpenClawDashboardUrl] = useState("http://127.0.0.1:18789/")
  const [openshellGateway, setOpenshellGateway] = useState("nemoclaw")
  const [exposePublicly, setExposePublicly] = useState(false)
  const [controllerPlan, setControllerPlan] = useState<ControllerPlan | null>(null)
  const [controllerMessage, setControllerMessage] = useState("")
  const [controllerPlanning, setControllerPlanning] = useState(false)

  const sourceSandbox = useMemo(
    () => sandboxes.find((sandbox) => sandbox.id === sourceSandboxId) || null,
    [sandboxes, sourceSandboxId],
  )
  const activeBlueprint = blueprints.find((blueprint) => blueprint.id === selectedBlueprint)
  const activeIndex = steps.findIndex((step) => step.key === activeStep)

  useEffect(() => {
    fetch("/api/sandbox/create", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (Array.isArray(data?.blueprints)) setBlueprints(data.blueprints)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!sourceSandboxId && sandboxes[0]) {
      setSourceSandboxId(sandboxes[0].id)
    }
  }, [sandboxes, sourceSandboxId])

  useEffect(() => {
    if (!targetName && sourceSandbox) {
      setTargetName(defaultCloneName(sourceSandbox))
    }
  }, [sourceSandbox, targetName])

  const canContinue = (() => {
    if (activeStep === "source") return Boolean(sourceSandbox)
    if (activeStep === "target") return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(targetName) && targetName.length <= 63
    if (activeStep === "options") return Boolean(backupPath.trim() && restorePath.trim())
    if (activeStep === "review") return Boolean(sourceSandbox && targetName.trim())
    return false
  })()

  const goNext = () => {
    const next = steps[activeIndex + 1]
    if (next) setActiveStep(next.key)
  }

  const goBack = () => {
    const previous = steps[activeIndex - 1]
    if (previous) setActiveStep(previous.key)
  }

  const appendLog = (line: string) => {
    setRunLog((current) => [...current, line])
  }

  async function runCloneWizard() {
    if (!sourceSandbox || running) return
    try {
      setRunning(true)
      setMessage("")
      setRunLog([])
      setActiveStep("run")

      appendLog(`Creating target sandbox ${targetName}...`)
      const createResponse = await fetch("/api/sandbox/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blueprint: selectedBlueprint,
          sandboxName: targetName.trim(),
          enableTailscale,
          policy: null,
          preset: null,
        }),
      })
      const createData = await createResponse.json()
      if (!createResponse.ok) {
        throw new Error([createData.error, createData.verification?.summary, createData.verification?.error, createData.stdout, createData.stderr].filter(Boolean).join("\n\n") || "Failed to create target sandbox")
      }
      const createdSandboxId = createData.verification?.details?.id || createData.verification?.details?.name || createData.sandboxName
      appendLog(`Target sandbox ready: ${createdSandboxId}.`)

      appendLog(`Backing up ${sourceSandbox.name}:${backupPath.trim()}...`)
      const backupResponse = await fetch(`/api/sandbox/${encodeURIComponent(sourceSandbox.id)}/backup?${new URLSearchParams({ path: backupPath.trim() })}`)
      if (!backupResponse.ok) {
        const data = await backupResponse.json().catch(() => ({}))
        throw new Error(data.error || "Failed to create source backup")
      }
      const backupBlob = await backupResponse.blob()
      const backupFileName = contentDispositionFileName(backupResponse.headers.get("content-disposition"), `${sourceSandbox.name}-backup.tar.gz`)
      appendLog(`Backup captured: ${backupFileName} (${Math.ceil(backupBlob.size / 1024)} KiB).`)

      appendLog(`Restoring backup into ${createdSandboxId}:${restorePath.trim()}...`)
      const form = new FormData()
      form.set("archive", new File([backupBlob], backupFileName, { type: "application/gzip" }))
      form.set("targetPath", restorePath.trim())
      form.set("replace", replaceTarget ? "true" : "false")
      const restoreResponse = await fetch(`/api/sandbox/${encodeURIComponent(createdSandboxId)}/restore`, {
        method: "POST",
        body: form,
      })
      const restoreData = await restoreResponse.json()
      if (!restoreResponse.ok) throw new Error(restoreData.error || "Failed to restore backup into target sandbox")
      appendLog(restoreData.note || "Restore complete.")

      appendLog("Refreshing inventory...")
      await onInventoryRefresh()
      setMessage(`Clone complete: ${sourceSandbox.name} -> ${targetName.trim()}.`)
    } catch (error) {
      const text = error instanceof Error ? error.message : "Clone wizard failed"
      appendLog(text)
      setMessage(text)
    } finally {
      setRunning(false)
    }
  }

  async function generateControllerPlan() {
    try {
      setControllerPlanning(true)
      setControllerMessage("")
      setControllerPlan(null)

      const response = await fetch("/api/controller-node/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controllerName,
          controllerHost,
          sshTarget,
          installDir,
          repoUrl,
          dashboardPort,
          terminalPort,
          openClawDashboardUrl,
          openshellGateway,
          exposePublicly,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || "Failed to generate controller node plan")
      setControllerPlan(data)
      setControllerMessage(`Launch kit ready for ${data.controller.url}.`)
    } catch (error) {
      setControllerMessage(error instanceof Error ? error.message : "Failed to generate controller node plan")
    } finally {
      setControllerPlanning(false)
    }
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setControllerMessage(`${label} copied.`)
    } catch {
      setControllerMessage("Clipboard access was blocked. Select the command text manually.")
    }
  }

  return (
    <div className="space-y-6">
      <section className="panel p-8">
        <p className="text-[10px] font-mono uppercase tracking-wider text-[var(--nvidia-green)]">Guided Tasks</p>
        <h1 className="mt-2 text-xl font-semibold uppercase tracking-wider text-[var(--foreground)]">Wizards</h1>
        <p className="mt-2 max-w-3xl text-sm text-[var(--foreground-dim)]">
          Step-by-step workflows for common operations, including remote controller bootstrap and sandbox cloning.
        </p>
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-[var(--border-subtle)] p-5">
          <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-start">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Spawn a Controller Node</h2>
              <p className="mt-1 text-xs text-[var(--foreground-dim)]">Prepare a remote VPS to run OpenShell Control near another OpenShell gateway or sandbox host.</p>
            </div>
            <span className="status-chip border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-2.5 py-1 text-[var(--foreground-dim)]">
              remote control plane
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 p-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.8fr)]">
          <div className="space-y-5">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Controller Name</span>
                <input value={controllerName} onChange={(event) => setControllerName(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Controller Host</span>
                <input value={controllerHost} onChange={(event) => setControllerHost(event.target.value)} placeholder="vps.example.com" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">SSH Target</span>
                <input value={sshTarget} onChange={(event) => setSshTarget(event.target.value)} placeholder="ubuntu@vps.example.com" className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Install Directory</span>
                <input value={installDir} onChange={(event) => setInstallDir(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2 md:col-span-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Repository URL</span>
                <input value={repoUrl} onChange={(event) => setRepoUrl(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Dashboard Port</span>
                <input value={dashboardPort} onChange={(event) => setDashboardPort(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Terminal Port</span>
                <input value={terminalPort} onChange={(event) => setTerminalPort(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">OpenClaw Dashboard URL</span>
                <input value={openClawDashboardUrl} onChange={(event) => setOpenClawDashboardUrl(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">OpenShell Gateway</span>
                <input value={openshellGateway} onChange={(event) => setOpenshellGateway(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
              </label>
            </div>
            <label className="flex items-start gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3">
              <input type="checkbox" checked={exposePublicly} onChange={(event) => setExposePublicly(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--nvidia-green)]" />
              <span>
                <span className="block text-xs font-mono uppercase tracking-wider text-[var(--foreground)]">Controller UI is directly reachable</span>
                <span className="mt-1 block text-[11px] text-[var(--foreground-dim)]">Leave this off when you access the VPS through SSH tunnels, WireGuard, or Tailscale.</span>
              </span>
            </label>
            <button type="button" onClick={generateControllerPlan} disabled={controllerPlanning || !controllerHost.trim()} className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">
              {controllerPlanning ? "Preparing..." : "Generate Launch Kit"}
            </button>
            {controllerMessage && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-sm text-[var(--foreground-dim)]">{controllerMessage}</div>}
          </div>

          <div className="space-y-4">
            <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Topology</h3>
              <div className="mt-3 space-y-2 text-xs text-[var(--foreground-dim)]">
                <p>Controller VPS: {controllerHost || "not set"}</p>
                <p>Sandbox host/gateway: {openshellGateway || "nemoclaw"}</p>
                <p>OpenClaw upstream: {openClawDashboardUrl}</p>
              </div>
            </div>
            {controllerPlan ? (
              <div className="space-y-4">
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">SSH Bootstrap</h3>
                    <button type="button" onClick={() => copyText(controllerPlan.commands.ssh, "SSH bootstrap")} className="action-button px-3 py-1.5 text-[10px]">Copy</button>
                  </div>
                  <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-[11px] leading-5 text-[var(--foreground-dim)]">{controllerPlan.commands.ssh}</pre>
                </div>
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Controller Env</h3>
                    <button type="button" onClick={() => copyText(controllerPlan.env, "Controller env")} className="action-button px-3 py-1.5 text-[10px]">Copy</button>
                  </div>
                  <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-sm border border-[var(--border-subtle)] bg-[var(--background)] p-3 text-[11px] leading-5 text-[var(--foreground-dim)]">{controllerPlan.env}</pre>
                </div>
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Readiness Checks</h3>
                  <div className="mt-3 space-y-2">
                    {controllerPlan.checks.map((check) => (
                      <p key={check} className="text-xs text-[var(--foreground-dim)]">{check}</p>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-sm text-[var(--foreground-dim)]">
                Enter the remote node details to generate a controller bootstrap command and matching environment block.
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="border-b border-[var(--border-subtle)] p-5">
          <div className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-start">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">Clone Sandbox</h2>
              <p className="mt-1 text-xs text-[var(--foreground-dim)]">Create a fresh sandbox, back up the source, then restore into the target.</p>
            </div>
            <span className="status-chip border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-2.5 py-1 text-[var(--foreground-dim)]">
              backup + restore
            </span>
          </div>
        </div>

        <div className="border-b border-[var(--border-subtle)] p-4">
          <div className="grid grid-cols-5 gap-2 max-md:grid-cols-1">
            {steps.map((step, index) => (
              <button
                key={step.key}
                type="button"
                onClick={() => setActiveStep(step.key)}
                className={`rounded-sm border px-3 py-2 text-left text-xs font-mono uppercase tracking-wider ${
                  activeStep === step.key
                    ? "border-[var(--nvidia-green)] bg-[var(--surface-hover)] text-[var(--foreground)]"
                    : index < activeIndex
                      ? "border-[var(--nvidia-green)]/40 text-[var(--nvidia-green)]"
                      : "border-[var(--border-subtle)] text-[var(--foreground-dim)]"
                }`}
              >
                {index + 1}. {step.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-5">
          {activeStep === "source" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Choose Source Sandbox</h3>
                <p className="mt-1 text-xs text-[var(--foreground-dim)]">This sandbox will be archived from the selected source directory.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sandboxes.map((sandbox) => (
                  <button
                    key={sandbox.id}
                    type="button"
                    onClick={() => {
                      setSourceSandboxId(sandbox.id)
                      setTargetName(defaultCloneName(sandbox))
                    }}
                    className={`rounded-sm border p-4 text-left ${
                      sourceSandboxId === sandbox.id
                        ? "border-[var(--nvidia-green)] bg-[var(--surface-hover)]"
                        : "border-[var(--border-subtle)] bg-[var(--background-tertiary)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-mono font-semibold text-[var(--foreground)]">{sandbox.name}</span>
                      <span className="status-chip bg-[var(--status-running-bg)] px-2 py-1 text-[var(--status-running)]">{sandbox.status}</span>
                    </div>
                    <p className="mt-2 truncate text-xs text-[var(--foreground-dim)]">{sandbox.namespace} / {sandbox.sshHostAlias || sandbox.ip}</p>
                  </button>
                ))}
              </div>
              {sandboxes.length === 0 && (
                <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4 text-sm text-[var(--foreground-dim)]">
                  No sandboxes are available to clone yet.
                </div>
              )}
            </div>
          )}

          {activeStep === "target" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Configure Target Sandbox</h3>
                <p className="mt-1 text-xs text-[var(--foreground-dim)]">Choose the sandbox blueprint and target name.</p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {blueprints.map((blueprint) => (
                  <button
                    key={blueprint.id}
                    type="button"
                    onClick={() => setSelectedBlueprint(blueprint.id)}
                    className={`rounded-sm border p-4 text-left ${selectedBlueprint === blueprint.id ? "border-[var(--nvidia-green)] bg-[var(--surface-hover)]" : "border-[var(--border-subtle)] bg-[var(--background-tertiary)]"}`}
                  >
                    <span className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">{blueprint.label}</span>
                    <p className="mt-2 text-xs text-[var(--foreground-dim)]">{blueprint.description}</p>
                  </button>
                ))}
              </div>
              <label className="block space-y-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Target Sandbox Name</span>
                <input
                  value={targetName}
                  onChange={(event) => setTargetName(event.target.value)}
                  placeholder="source-clone"
                  className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)] focus:outline-none focus:border-[var(--nvidia-green)]"
                />
              </label>
              {activeBlueprint?.supportsTailscale && (
                <label className="flex items-center gap-3 text-sm font-mono text-[var(--foreground)]">
                  <input type="checkbox" checked={enableTailscale} onChange={(event) => setEnableTailscale(event.target.checked)} />
                  Enable Tailscale
                </label>
              )}
            </div>
          )}

          {activeStep === "options" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Clone Options</h3>
                <p className="mt-1 text-xs text-[var(--foreground-dim)]">Most clones should back up and restore /sandbox.</p>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Source Backup Path</span>
                  <input value={backupPath} onChange={(event) => setBackupPath(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
                </label>
                <label className="block space-y-2">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">Target Restore Path</span>
                  <input value={restorePath} onChange={(event) => setRestorePath(event.target.value)} className="w-full rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] px-3 py-2 text-xs font-mono text-[var(--foreground)]" />
                </label>
              </div>
              <label className="flex items-start gap-3 rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3">
                <input type="checkbox" checked={replaceTarget} onChange={(event) => setReplaceTarget(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--nvidia-green)]" />
                <span>
                  <span className="block text-xs font-mono uppercase tracking-wider text-[var(--foreground)]">Replace target contents</span>
                  <span className="mt-1 block text-[11px] text-[var(--foreground-dim)]">Recommended for cloning into a new sandbox.</span>
                </span>
              </label>
            </div>
          )}

          {activeStep === "review" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Review Clone Plan</h3>
                <p className="mt-1 text-xs text-[var(--foreground-dim)]">The wizard will run these steps in order.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {[
                  ["Source", sourceSandbox?.name || "-"],
                  ["Target", targetName || "-"],
                  ["Blueprint", activeBlueprint?.label || selectedBlueprint],
                  ["Backup Path", backupPath],
                  ["Restore Path", restorePath],
                  ["Restore Mode", replaceTarget ? "replace" : "merge"],
                ].map(([label, value]) => (
                  <div key={label} className="metric p-4">
                    <p className="text-[10px] uppercase tracking-wider text-[var(--foreground-dim)]">{label}</p>
                    <p className="mt-1 break-words font-mono text-sm text-[var(--foreground)]">{value}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeStep === "run" && (
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--foreground)]">Run Clone</h3>
                <p className="mt-1 text-xs text-[var(--foreground-dim)]">Progress appears here as each operation completes.</p>
              </div>
              <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-4">
                {runLog.length === 0 ? (
                  <p className="text-xs text-[var(--foreground-dim)]">Ready to clone.</p>
                ) : (
                  <div className="space-y-2">
                    {runLog.map((line, index) => (
                      <p key={`${line}-${index}`} className="font-mono text-xs text-[var(--foreground-dim)]">{line}</p>
                    ))}
                  </div>
                )}
              </div>
              {message && <div className="rounded-sm border border-[var(--border-subtle)] bg-[var(--background-tertiary)] p-3 text-sm text-[var(--foreground-dim)] whitespace-pre-wrap">{message}</div>}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[var(--border-subtle)] p-5">
          <button type="button" onClick={goBack} disabled={activeIndex === 0 || running} className="action-button px-4 py-2">
            Back
          </button>
          {activeStep === "review" || activeStep === "run" ? (
            <button type="button" onClick={runCloneWizard} disabled={!sourceSandbox || !targetName.trim() || running} className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">
              {running ? "Running..." : "Start Clone"}
            </button>
          ) : (
            <button type="button" onClick={goNext} disabled={!canContinue || running} className="rounded-sm bg-[var(--nvidia-green)] px-4 py-2 text-xs font-mono uppercase tracking-wider text-black disabled:opacity-50">
              Next
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
