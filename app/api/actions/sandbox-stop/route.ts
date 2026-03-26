import { NextResponse } from 'next/server'

// Mock action handler
export async function POST(request: Request) {
  try {
    // In production, this would:
    // 1. Call OpenShell API to stop the sandbox
    // 2. Wait for confirmation
    // 3. Return success/error response
    await new Promise(resolve => setTimeout(resolve, 1000))

    return NextResponse.json({
      message: 'Sandbox stopped successfully'
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to stop sandbox' },
      { status: 500 }
    )
  }
}