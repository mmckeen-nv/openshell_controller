import { NextResponse } from "next/server"
import { backupSandboxArchive } from "@/app/lib/sandboxFiles"

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\w.-]/g, "_") || "sandbox-backup.tar.gz"
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const requestUrl = new URL(request.url)
    const sourcePath = requestUrl.searchParams.get("path") || "/sandbox"
    const backup = await backupSandboxArchive(sandboxId, sourcePath)

    return new NextResponse(new Uint8Array(backup.bytes), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": contentDisposition(backup.fileName),
        "content-length": String(backup.bytes.byteLength),
        "content-type": "application/gzip",
        "x-sandbox-name": backup.sandboxName,
        "x-sandbox-path": backup.sourcePath,
        "x-sandbox-backup-created-at": backup.createdAt,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create sandbox backup"
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|exist|directory/.test(message) ? 400 : 500 })
  }
}
