import { NextResponse } from "next/server"
import { execOpenShell, normalizeSandboxPhase, resolveSandboxRef } from "@/app/lib/openshellHost"
import { listBackupCatalog } from "@/app/lib/backupCatalog"
import { getNemoClawDoctorReport } from "@/app/lib/nemoclawCli"

function parseField(output: string, label: string) {
  const normalizedLabel = label.toLowerCase()
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.toLowerCase().startsWith(`${normalizedLabel}:`))

  return line ? line.slice(label.length + 1).trim() : null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const startedAt = Date.now()
  try {
    const { sandboxId } = await params
    const resolved = await resolveSandboxRef(sandboxId)
    const phase = normalizeSandboxPhase(parseField(resolved.details, "Phase"))
    const catalog = await listBackupCatalog()
    const relatedBackups = catalog.filter((backup) => backup.sandboxId === sandboxId || backup.sandboxName === resolved.name)
    const nemoclawDoctor = await getNemoClawDoctorReport(resolved.name).catch((error) => ({
      available: false,
      supported: false,
      attempted: false,
      version: null,
      minimumVersion: "0.0.37",
      report: null,
      error: error instanceof Error ? error.message : "NemoClaw doctor check failed",
    }))

    let sshConfig = ""
    let sshConfigError = ""
    try {
      const result = await execOpenShell(["sandbox", "ssh-config", resolved.name])
      sshConfig = result.stdout.trim()
    } catch (error) {
      sshConfigError = error instanceof Error ? error.message : "ssh-config unavailable"
    }

    const checks = [
      {
        key: "resolve",
        label: "OpenShell resolution",
        ok: true,
        detail: `${resolved.name} resolved by ${resolved.resolvedBy}.`,
      },
      {
        key: "phase",
        label: "Sandbox phase",
        ok: /running|ready/i.test(phase),
        detail: phase,
      },
      {
        key: "ssh",
        label: "SSH config",
        ok: sshConfig.length > 0,
        detail: sshConfig ? "Host alias is available." : sshConfigError || "No SSH config returned.",
      },
      {
        key: "backup",
        label: "Catalog backup",
        ok: relatedBackups.length > 0,
        detail: relatedBackups.length > 0
          ? `${relatedBackups.length} saved backup${relatedBackups.length === 1 ? "" : "s"} in catalog.`
          : "No saved catalog backups yet.",
      },
      {
        key: "nemoclaw-doctor",
        label: "NemoClaw doctor",
        ok: !nemoclawDoctor.supported || Boolean(nemoclawDoctor.report && nemoclawDoctor.report.status !== "fail"),
        detail: nemoclawDoctor.supported
          ? nemoclawDoctor.report
            ? `NemoClaw ${nemoclawDoctor.version || "unknown"} doctor reported ${nemoclawDoctor.report.status} (${nemoclawDoctor.report.failed} failed, ${nemoclawDoctor.report.warnings} warnings).`
            : nemoclawDoctor.error || "NemoClaw doctor did not return a report."
          : `Using OpenShell compatibility checks; NemoClaw doctor requires ${nemoclawDoctor.minimumVersion}+${nemoclawDoctor.version ? `, found ${nemoclawDoctor.version}` : ""}.`,
      },
    ]

    return NextResponse.json({
      ok: true,
      sandbox: {
        requested: resolved.requested,
        id: resolved.id,
        name: resolved.name,
        phase,
      },
      checks,
      nemoclaw: {
        doctor: {
          available: nemoclawDoctor.available,
          supported: nemoclawDoctor.supported,
          attempted: nemoclawDoctor.attempted,
          version: nemoclawDoctor.version,
          minimumVersion: nemoclawDoctor.minimumVersion,
          status: nemoclawDoctor.report?.status ?? null,
          failed: nemoclawDoctor.report?.failed ?? null,
          warnings: nemoclawDoctor.report?.warnings ?? null,
          error: nemoclawDoctor.error ?? null,
        },
      },
      backupCount: relatedBackups.length,
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check sandbox health"
    return NextResponse.json({
      ok: false,
      error: message,
      checks: [
        {
          key: "resolve",
          label: "OpenShell resolution",
          ok: false,
          detail: message,
        },
      ],
      durationMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    }, { status: 500 })
  }
}
