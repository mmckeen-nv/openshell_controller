import { NextResponse } from 'next/server'

// Mock NemoClaw configuration
// In production, this would call OpenShell API
const mockNemoclawConfig = {
  enabled: true,
  instances: 1,
  models: ['qwen2.5-vl:7b', 'llama3.1:8b', 'mistral:7b']
}

export async function GET() {
  try {
    return NextResponse.json(mockNemoclawConfig)
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch NemoClaw config' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    return NextResponse.json({ ...mockNemoclawConfig, ...body })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update NemoClaw config' },
      { status: 500 }
    )
  }
}