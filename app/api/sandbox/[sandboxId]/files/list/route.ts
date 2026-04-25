import { NextResponse } from "next/server"
import { listSandboxFiles } from "@/app/lib/sandboxFiles"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const requestUrl = new URL(request.url)
    const path = requestUrl.searchParams.get("path") || "/sandbox"
    const listing = await listSandboxFiles(sandboxId, path)

    return NextResponse.json({
      ok: true,
      listing,
    }, {
      headers: {
        "cache-control": "no-store",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list sandbox files"
    return NextResponse.json({ ok: false, error: message }, { status: /required|path|directory|readable/.test(message) ? 400 : 500 })
  }
}
