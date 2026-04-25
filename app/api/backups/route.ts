import { NextResponse } from "next/server"
import { createCatalogBackup, listBackupCatalog } from "@/app/lib/backupCatalog"
import { recordActivity } from "@/app/lib/activityLog"

export async function GET() {
  const backups = await listBackupCatalog()
  return NextResponse.json({ ok: true, backups })
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const sandboxId = typeof body?.sandboxId === "string" ? body.sandboxId.trim() : ""
    const sourcePath = typeof body?.sourcePath === "string" && body.sourcePath.trim() ? body.sourcePath.trim() : "/sandbox"
    if (!sandboxId) throw new Error("sandboxId is required")

    const backup = await createCatalogBackup(sandboxId, sourcePath)
    await recordActivity({
      type: "backup.catalog.create",
      status: "success",
      sandboxId,
      sandboxName: backup.sandboxName,
      message: `Saved backup ${backup.fileName} to catalog.`,
      metadata: { backupId: backup.id, sourcePath: backup.sourcePath, size: backup.size },
    })

    return NextResponse.json({ ok: true, backup })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save backup"
    await recordActivity({
      type: "backup.catalog.create",
      status: "error",
      message,
    }).catch(() => undefined)
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|exist|directory/.test(message) ? 400 : 500 })
  }
}
