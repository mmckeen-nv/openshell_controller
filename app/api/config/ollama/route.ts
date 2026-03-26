import { NextResponse } from 'next/server'

// Mock Ollama configuration
// In production, this would call Ollama API at localhost:11434/api/tags
const mockOllamaConfig = {
  enabled: true,
  port: 11434,
  models: ['qwen2.5-vl:7b', 'llama3.1:8b', 'mistral:7b', 'qwen2.5-coder:32b', 'gemma2:9b']
}

export async function GET() {
  try {
    return NextResponse.json(mockOllamaConfig)
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch Ollama config' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    return NextResponse.json({ ...mockOllamaConfig, ...body })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to update Ollama config' },
      { status: 500 }
    )
  }
}