import { NextResponse } from 'next/server'
import {
  OPENSHELL_BIN,
  OPENSHELL_HOME,
  OPENSHELL_XDG_CONFIG_HOME,
  openshellGatewayAddressEnv,
} from '@/app/lib/hostCommands'

export async function GET() {
  try {
    const gatewayAddressEnv = openshellGatewayAddressEnv()
    return NextResponse.json({
      ok: true,
      enabled: true,
      openshellBin: OPENSHELL_BIN,
      openshellHome: OPENSHELL_HOME,
      xdgConfigHome: OPENSHELL_XDG_CONFIG_HOME,
      gatewayAddressEnv,
      gatewayOverrideActive: Boolean(gatewayAddressEnv.OPENSHELL_GATEWAY_URL || gatewayAddressEnv.OPENSHELL_GATEWAY_HOST),
      note: 'These values are passed to controller-launched OpenShell/NemoClaw child processes. Upstream CLIs must still honor them for full gateway override support.',
    })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : 'Failed to fetch OpenShell config' },
      { status: 500 }
    )
  }
}

export async function POST() {
  return NextResponse.json(
    { ok: false, error: 'OpenShell config is read from environment variables or ~/.config/openshell/*.json; update those files and restart the controller.' },
    { status: 405 }
  )
}
