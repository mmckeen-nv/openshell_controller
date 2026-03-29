import { NextResponse } from 'next/server'

const defaultPolicy = {
  version: 1,
  filesystem_policy: {
    include_workdir: true,
    read_only: ['/usr', '/lib', '/etc', '/proc', '/dev/urandom'],
    read_write: ['/sandbox', '/tmp', '/dev/null'],
  },
  landlock: {
    compatibility: 'best_effort',
  },
  process: {
    run_as_user: 'sandbox',
    run_as_group: 'sandbox',
  },
  network_policies: {},
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    return NextResponse.json({ sandboxId, currentConfig: defaultPolicy })
  } catch (error) {
    console.error('Error fetching sandbox configuration:', error)
    return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string }> }
) {
  try {
    const { sandboxId } = await params
    const body = await request.json()
    const policy = body?.policy || defaultPolicy
    return NextResponse.json({
      success: true,
      sandboxId,
      policy,
      appliedAt: new Date().toISOString(),
      note: 'OpenShell-aligned policy accepted. Dynamic network_policies are live-updatable; static sections require sandbox recreation.',
    })
  } catch (error) {
    console.error('Error updating sandbox configuration:', error)
    return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
  }
}
