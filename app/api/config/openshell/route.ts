import { NextResponse } from 'next/server'

// Mock OpenShell configuration
// In production, this would call OpenShell API
const mockOpenshellConfig = {
  enabled: true,
  port: 8080,
  policies: ['resource-control', 'network-isolation', 'audit-logging']
}

export async function GET() {
  try {
    return NextResponse.json(mockOpenshellConfig)
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch OpenShell config' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    return NextResponse.json({ ...mockOpenshellConfig, ...body })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update OpenShell config' },
      { status: 500 }
    )
  }
}