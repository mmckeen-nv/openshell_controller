import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const sandboxId = searchParams.get('sandboxId') || 'unknown'

  return NextResponse.json({
    ok: true,
    sandboxId,
    attached: false,
    note: 'Embedded terminal transport is not live yet. This route is the integration point for attaching to an OpenShell terminal session.',
    suggestedCommand: `openshell sandbox exec ${sandboxId} -- /bin/sh`
  })
}
