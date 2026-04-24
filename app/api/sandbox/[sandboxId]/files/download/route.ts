import { NextResponse } from "next/server"
import { downloadSandboxFile } from "@/app/lib/sandboxFiles"

function contentDisposition(fileName: string) {
  const fallback = fileName.replace(/[^\w.-]/g, "_") || "download.bin"
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const requestUrl = new URL(request.url)
    const sourcePath = requestUrl.searchParams.get("path") || ""
    const downloaded = await downloadSandboxFile(sandboxId, sourcePath)

    return new NextResponse(new Uint8Array(downloaded.bytes), {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": contentDisposition(downloaded.fileName),
        "content-length": String(downloaded.bytes.byteLength),
        "content-type": "application/octet-stream",
        "x-sandbox-name": downloaded.sandboxName,
        "x-sandbox-path": downloaded.path,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to download file"
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|large|exist/.test(message) ? 400 : 500 })
  }
}
