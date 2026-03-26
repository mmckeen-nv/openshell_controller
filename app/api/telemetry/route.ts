import { NextResponse } from 'next/server'

// Mock telemetry data for development
// In production, this would call OpenShell API
export async function GET() {
  try {
    const cpu = Math.random() * 40 + 20 // 20-60%
    const memory = Math.random() * 30 + 40 // 40-70%
    const disk = Math.random() * 15 + 50 // 50-65%
    const gpu = {
      memoryUsed: Math.random() * 80 + 20, // 20-100 GB
      memoryTotal: 80,
      temperature: Math.random() * 30 + 60 // 60-90°C
    }

    return NextResponse.json({
      cpu: parseFloat(cpu.toFixed(1)),
      memory: parseFloat(memory.toFixed(1)),
      disk: parseFloat(disk.toFixed(1)),
      gpu
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch telemetry' },
      { status: 500 }
    )
  }
}