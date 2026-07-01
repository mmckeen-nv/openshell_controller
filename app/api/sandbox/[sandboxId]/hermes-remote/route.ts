import { NextResponse } from "next/server"
import { isUserAuthorizedForSandbox } from "@/app/lib/controlAuth"
import { exposeHermesRemote, hermesRemoteMode, readHermesRemoteAccess } from "@/app/lib/hermesRemote"
import { resolveSandboxRef } from "@/app/lib/openshellHost"

// The access record contains the session token (the desktop app's
// credential), so OAuth users must hold explicit access to this sandbox.
// Operators pass middleware without x-forwarded-user and are fully trusted.
function forbiddenForIdpUser(request: Request, sandboxName: string) {
  const idpUser = request.headers.get("x-forwarded-user")?.trim().toLowerCase()
  if (idpUser && !isUserAuthorizedForSandbox(idpUser, sandboxName)) {
    return NextResponse.json(
      { ok: false, error: `Forbidden: no access to sandbox ${sandboxName}` },
      { status: 403 },
    )
  }
  return null
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  let sandboxName = sandboxId
  try {
    sandboxName = (await resolveSandboxRef(sandboxId)).name
  } catch {
    // Fall back to treating the ref as a name; access file lookup decides.
  }

  const forbidden = forbiddenForIdpUser(request, sandboxName)
  if (forbidden) return forbidden

  const access = readHermesRemoteAccess(sandboxName)
  if (!access) {
    return NextResponse.json({ ok: false, configured: false, mode: hermesRemoteMode() }, { status: 404 })
  }
  return NextResponse.json({ ok: true, configured: true, access })
}

// POST = (re)expose on demand: lets operators enable remote desktop for
// pre-existing Hermes sandboxes or self-heal after manual teardown.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  let sandboxName = sandboxId
  try {
    sandboxName = (await resolveSandboxRef(sandboxId)).name
  } catch {
    return NextResponse.json({ ok: false, error: `Sandbox not found: ${sandboxId}` }, { status: 404 })
  }

  const forbidden = forbiddenForIdpUser(request, sandboxName)
  if (forbidden) return forbidden

  const result = await exposeHermesRemote(sandboxName)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 })
  }
  return NextResponse.json({ ok: true, configured: true, access: result.access })
}
