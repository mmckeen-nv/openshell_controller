import { NextResponse } from "next/server"
import { assertRequestContentLength, uploadSandboxFile, uploadSandboxFiles } from "@/app/lib/sandboxFiles"

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    assertRequestContentLength(request)
    const form = await request.formData()
    const file = form.get("file")
    const files = form.getAll("files")
    const rawPath = form.get("path")
    const rawRelativePaths = form.get("relativePaths")
    const destinationPath = typeof rawPath === "string" && rawPath.trim()
      ? rawPath.trim()
      : "/sandbox/"

    if (files.length > 0) {
      const relativePaths = typeof rawRelativePaths === "string" ? JSON.parse(rawRelativePaths) : []
      if (!Array.isArray(relativePaths)) throw new Error("relative paths are required for directory upload")
      const payloads = await Promise.all(files.map(async (item, index) => {
        if (!(item instanceof File)) throw new Error("files must contain only file uploads")
        return {
          fileName: item.name,
          relativePath: typeof relativePaths[index] === "string" && relativePaths[index] ? relativePaths[index] : item.name,
          payload: Buffer.from(await item.arrayBuffer()),
        }
      }))
      const uploaded = await uploadSandboxFiles(sandboxId, destinationPath, payloads)

      return NextResponse.json({
        ok: true,
        uploaded,
        note: `Uploaded ${uploaded.files.length} file${uploaded.files.length === 1 ? "" : "s"} to ${destinationPath}.`,
      })
    }

    if (!(file instanceof File)) throw new Error("file is required")
    const targetPath = destinationPath.endsWith("/") ? destinationPath : rawPath ? destinationPath : `/sandbox/${file.name}`
    const payload = Buffer.from(await file.arrayBuffer())
    const uploaded = await uploadSandboxFile(sandboxId, targetPath, file.name, payload)

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
