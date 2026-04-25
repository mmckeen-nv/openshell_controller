import { NextResponse } from "next/server"
import { restoreSandboxArchive } from "@/app/lib/sandboxFiles"
import { recordActivity } from "@/app/lib/activityLog"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const form = await request.formData()
    const file = form.get("archive")
    const rawTargetPath = form.get("targetPath")
    const rawReplace = form.get("replace")
    if (!(file instanceof File)) throw new Error("archive is required")

    const targetPath = typeof rawTargetPath === "string" && rawTargetPath.trim()
      ? rawTargetPath.trim()
      : "/sandbox"
    const replace = rawReplace === "true" || rawReplace === "1"
    const payload = Buffer.from(await file.arrayBuffer())
    const restored = await restoreSandboxArchive(sandboxId, targetPath, file.name, payload, replace)
    await recordActivity({
      type: "backup.upload.restore",
      status: "success",
      sandboxId,
      sandboxName: restored.sandboxName,
      message: `Restored uploaded archive ${file.name} into ${restored.targetPath}.`,
      metadata: { targetPath: restored.targetPath, mode: restored.mode, bytes: restored.bytes },
    }).catch(() => undefined)

    return NextResponse.json({
      ok: true,
      restored,
      note: `Restored ${file.name} into ${restored.targetPath} (${restored.mode}).`,
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
