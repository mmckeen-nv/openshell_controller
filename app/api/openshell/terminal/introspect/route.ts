import { NextResponse } from 'next/server'
import { dockerExecInOpenShell, OPENSHELL_NAMESPACE } from '../../../../lib/openshellHost'

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const sandboxId = searchParams.get('sandboxId')

    if (!sandboxId) {
      return NextResponse.json({ error: 'sandboxId is required' }, { status: 400 })
    }

    const result = await dockerExecInOpenShell(
      `kubectl -n ${OPENSHELL_NAMESPACE} get pod ${sandboxId} -o json`
    )

    const pod = JSON.parse(result.stdout)
    const containerNames = Array.isArray(pod?.spec?.containers) ? pod.spec.containers.map((c: any) => c.name) : []
    const containerImages = Array.isArray(pod?.spec?.containers) ? pod.spec.containers.map((c: any) => c.image) : []
    const statusNames = Array.isArray(pod?.status?.containerStatuses) ? pod.status.containerStatuses.map((c: any) => c.name) : []

    return NextResponse.json({
      ok: true,
      sandboxId,
      containers: containerNames,
      images: containerImages,
      runningStatuses: statusNames,
      raw: result.stdout.trim(),
      stderr: result.stderr.trim(),
      note: 'Pod/container introspection succeeded. Use this to select the right exec target for terminal attach.'
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to introspect sandbox pod'
    }, { status: 500 })
  }
}
