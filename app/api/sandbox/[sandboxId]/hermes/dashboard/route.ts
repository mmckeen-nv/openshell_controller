import { NextResponse } from 'next/server'
import { ensureHermesDashboardTunnel, resolveSandboxRef } from '@/app/lib/openshellHost'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> },
) {
  try {
    const { sandboxId } = await params
    const sandbox = await resolveSandboxRef(sandboxId)
    const { port, listenerPresent } = await ensureHermesDashboardTunnel(sandbox.name, sandbox.id ?? sandboxId)
    const proxyUrl = `/api/sandbox/${encodeURIComponent(sandboxId)}/hermes/proxy`

    return NextResponse.json({
      ok: true,
      sandboxId,
      sandboxName: sandbox.name,
      port,
      listenerPresent,
      proxyUrl,
      note: listenerPresent
        ? 'Hermes dashboard tunnel is active.'
        : 'Tunnel setup attempted but not yet confirmed. The dashboard may take a moment to start.',
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to start Hermes dashboard' },
      { status: 500 },
    )
  }
}
