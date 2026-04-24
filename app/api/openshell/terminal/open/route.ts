import { NextResponse } from 'next/server'
import { probeSandboxShell } from '../../../../lib/openshellHost'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sandboxId = searchParams.get('sandboxId')

    if (!sandboxId) {
      return NextResponse.json({ error: 'sandboxId is required' }, { status: 400 })
    }

    const result = await probeSandboxShell(sandboxId)

    return NextResponse.json({
      ok: true,
      sandboxId,
      attached: true,
      name: result.name,
      resolvedId: result.id,
      namespace: result.namespace,
      phase: result.phase,
      sshHostAlias: result.sshHostAlias,
      sshConfig: result.sshConfig,
      output: result.rawDetails,
      note: 'Sandbox inspection succeeded. Next step is persistent interactive terminal transport.',
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to probe terminal attach',
    }, { status: 500 })
  }
}
