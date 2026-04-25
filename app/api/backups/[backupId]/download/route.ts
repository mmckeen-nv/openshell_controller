import { NextResponse } from "next/server"
import { getCatalogBackup } from "@/app/lib/backupCatalog"

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\w.-]/g, "_") || "sandbox-backup.tar.gz"
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ backupId: string }> },
) {
  try {
    const { backupId } = await params
    const backup = await getCatalogBackup(backupId)
    return new NextResponse(new Uint8Array(backup.bytes), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": contentDisposition(backup.metadata.fileName),
        "content-length": String(backup.bytes.byteLength),
        "content-type": "application/gzip",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to download backup"
    return NextResponse.json({ ok: false, error: message }, { status: 404 })
  }
}
