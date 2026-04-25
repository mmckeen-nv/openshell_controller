import { NextResponse } from "next/server"
import { deleteCatalogBackup } from "@/app/lib/backupCatalog"
import { recordActivity } from "@/app/lib/activityLog"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { backupId } = await params
    await deleteCatalogBackup(backupId)
    await recordActivity({
      type: "backup.catalog.delete",
      status: "success",
      message: `Deleted catalog backup ${backupId}.`,
      metadata: { backupId },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete backup"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
