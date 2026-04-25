import { NextResponse } from "next/server"
import { restoreCatalogBackup } from "@/app/lib/backupCatalog"
import { recordActivity } from "@/app/lib/activityLog"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { backupId } = await params
    const body = await request.json()
    const sandboxId = typeof body?.sandboxId === "string" ? body.sandboxId.trim() : ""
    const targetPath = typeof body?.targetPath === "string" && body.targetPath.trim() ? body.targetPath.trim() : "/sandbox"
    const replace = body?.replace === true
    if (!sandboxId) throw new Error("sandboxId is required")

    const restored = await restoreCatalogBackup(backupId, sandboxId, targetPath, replace)
    await recordActivity({
      type: "backup.catalog.restore",
      status: "success",
      sandboxId,
      sandboxName: restored.sandboxName,
      message: `Restored catalog backup into ${restored.targetPath}.`,
      metadata: { backupId, targetPath: restored.targetPath, mode: restored.mode, bytes: restored.bytes },
    })

    return NextResponse.json({ ok: true, restored, note: `Restored catalog backup into ${restored.targetPath} (${restored.mode}).` })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restore catalog backup"
    await recordActivity({
      type: "backup.catalog.restore",
      status: "error",
      message,
    }).catch(() => undefined)
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|unsafe|archive/.test(message) ? 400 : 500 })
  }
}
