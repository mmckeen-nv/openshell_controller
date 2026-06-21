import { NextResponse } from "next/server"
import { assertRequestContentLength, restoreSandboxArchive } from "@/app/lib/sandboxFiles"
import { recordActivity } from "@/app/lib/activityLog"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    assertRequestContentLength(request)

    let archiveName: string
    let rawTargetPath: string | null
    let rawReplace: string | null
    let payload: Buffer

    const uploadToken = request.headers.get("x-restore-upload-token")
    if (uploadToken && /^[0-9a-f]{64}$/.test(uploadToken)) {
      // Body was pre-collected in server.mjs to work around a Next.js 15 bug
      // where fromNodeNextRequest disturbs large multipart IncomingMessage streams.
      const { readFile, unlink } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const tmpPath = join(tmpdir(), `openshell-restore-${uploadToken}.bin`)
      try {
        payload = await readFile(tmpPath)
        await unlink(tmpPath).catch(() => {})
      } catch {
        throw new Error("archive upload not found — token expired or invalid")
      }
      archiveName = request.headers.get("x-restore-archive-name") || "backup.tar.gz"
      rawTargetPath = request.headers.get("x-restore-target-path")
      rawReplace = request.headers.get("x-restore-replace")
    } else {
      const form = await request.formData()
      const file = form.get("archive")
      if (!(file instanceof File)) throw new Error("archive is required")
      rawTargetPath = form.get("targetPath") as string | null
      rawReplace = form.get("replace") as string | null
      archiveName = file.name
      payload = Buffer.from(await file.arrayBuffer())
    }

    const targetPath = typeof rawTargetPath === "string" && rawTargetPath.trim()
      ? rawTargetPath.trim()
      : "/sandbox"
    const replace = rawReplace === "true" || rawReplace === "1"
    const restored = await restoreSandboxArchive(sandboxId, targetPath, archiveName, payload, replace)
    await recordActivity({
      type: "backup.upload.restore",
      status: "success",
      sandboxId,
      sandboxName: restored.sandboxName,
      message: `Restored uploaded archive ${archiveName} into ${restored.targetPath}.`,
      metadata: { targetPath: restored.targetPath, mode: restored.mode, bytes: restored.bytes },
    }).catch(() => undefined)

    return NextResponse.json({
      ok: true,
      restored,
      note: `Restored ${archiveName} into ${restored.targetPath} (${restored.mode}).`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restore sandbox backup"
    await recordActivity({
      type: "backup.upload.restore",
      status: "error",
      message,
    }).catch(() => undefined)
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|unsafe|archive/.test(message) ? 400 : 500 })
  }
}
