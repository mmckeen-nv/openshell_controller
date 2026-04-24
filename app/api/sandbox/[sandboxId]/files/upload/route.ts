import { NextResponse } from "next/server"
import { uploadSandboxFile } from "@/app/lib/sandboxFiles"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const form = await request.formData()
    const file = form.get("file")
    const rawPath = form.get("path")
    if (!(file instanceof File)) throw new Error("file is required")
    const destinationPath = typeof rawPath === "string" && rawPath.trim()
      ? rawPath.trim()
      : `/sandbox/${file.name}`
    const payload = Buffer.from(await file.arrayBuffer())
    const uploaded = await uploadSandboxFile(sandboxId, destinationPath, file.name, payload)

    return NextResponse.json({
      ok: true,
      uploaded,
      note: `Uploaded ${file.name} to ${uploaded.path}.`,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to upload file"
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|exist/.test(message) ? 400 : 500 })
  }
}
