import { NextResponse } from 'next/server'

// Mock action handler
export async function POST(request: Request) {
  try {
    const { model } = await request.json()

    if (!model) {
      return NextResponse.json(
        { error: 'Model parameter is required' },
        { status: 400 }
      )
    }

    // In production, this would:
    // 1. Call Ollama API to switch the model
    // 2. Wait for confirmation
    // 3. Return success/error response
    await new Promise(resolve => setTimeout(resolve, 1000))

    return NextResponse.json({
      message: `Model switched to ${model} successfully`
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to switch model' },
      { status: 500 }
    )
  }
}