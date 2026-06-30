import { NextResponse } from "next/server"
import { isUserAuthorizedForSandbox } from "@/app/lib/controlAuth"
import { exposeOpenClawRemote, readOpenClawRemoteAccess, unexposeOpenClawRemote } from "@/app/lib/openclawRemote"
import { resolveSandboxRef } from "@/app/lib/openshellHost"

// The access record contains the gateway token (the mobile app's credential),
// so OAuth/IDP users must hold explicit access to this sandbox. Operators pass
// middleware without x-forwarded-user and are fully trusted.
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

async function resolveName(sandboxId: string): Promise<string> {
  try {
    return (await resolveSandboxRef(sandboxId)).name
  } catch {
    return sandboxId
  }
}

// Reachability is checked server-side: a browser fetch to the per-sandbox
// subdomain would be CORS-blocked (false "Unreachable"). The controller is a
// host process, so it probes the forward backend (bridgeIp:hostPort) directly —
// no DNS, no proxmox hairpin, no CORS. The gateway serves HTTP on the same port,
// so a plain GET answers when the forward + Traefik route are healthy. Falls
// back to the public https URL for records written before bridgeIp existed.
async function probeReachable(access: { bridgeIp?: string; hostPort: number; url: string }): Promise<boolean> {
  const target = access.bridgeIp
    ? `http://${access.bridgeIp}:${access.hostPort}/`
    : access.url.replace(/^wss:/i, "https:")
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(8000), redirect: "manual" })
    return res.status > 0
  } catch {
    return false
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  const sandboxName = await resolveName(sandboxId)

  const forbidden = forbiddenForIdpUser(request, sandboxName)
  if (forbidden) return forbidden

  const access = readOpenClawRemoteAccess(sandboxName)
  if (!access) {
    return NextResponse.json({ ok: false, configured: false }, { status: 404 })
  }
  const reachable = await probeReachable(access)
  return NextResponse.json({ ok: true, configured: true, access, reachable })
}

// POST = (re)expose on demand: lets operators enable the mobile-app remote
// gateway for an OpenClaw sandbox, or self-heal after manual teardown.
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

  const result = await exposeOpenClawRemote(sandboxName)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 })
  }
  return NextResponse.json({ ok: true, configured: true, access: result.access })
}

// DELETE = tear down the exposure (forward + UFW + Traefik rule + access record).
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  const { sandboxId } = await params
  const sandboxName = await resolveName(sandboxId)

  const forbidden = forbiddenForIdpUser(request, sandboxName)
  if (forbidden) return forbidden

  const result = await unexposeOpenClawRemote(sandboxName)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 })
  }
  return NextResponse.json({ ok: true, configured: false })
}
