import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({
    dashboardUrl: 'http://127.0.0.1:18789/',
    reachableFromServer: true,
    loopbackOnly: true,
    note: 'OpenClaw Gateway Dashboard is currently bound to loopback on the host. To expose it in a user browser, proxy it through this dashboard service or rebind the gateway.'
  })
}
