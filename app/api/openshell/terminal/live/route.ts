import { NextResponse } from 'next/server'

const TERMINAL_SERVER_URL = process.env.TERMINAL_SERVER_URL || 'http://127.0.0.1:3011'

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const response = await fetch(`${TERMINAL_SERVER_URL}/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sandboxId: body?.sandboxId,
        sessionId: body?.sessionId,
      }),
      cache: 'no-store',
    })

    const result = await response.json()
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: result.error || 'Failed to initialize live terminal session.' }, { status: 502 })
    }

    const wsBase = TERMINAL_SERVER_URL.replace(/^http/, 'ws')
    return NextResponse.json({
      ok: true,
      sessionId: result.sessionId,
      sandboxId: result.sandboxId,
      replay: result.replay,
      websocketUrl: `${wsBase}/ws?sessionId=${encodeURIComponent(result.sessionId)}&sandboxId=${encodeURIComponent(result.sandboxId)}`,
    })
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to reach terminal server.',
    }, { status: 500 })
  }
}
