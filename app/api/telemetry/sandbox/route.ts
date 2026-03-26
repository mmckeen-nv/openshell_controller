import { NextResponse } from "next/server"

export async function GET(
  request: Request,
  { params }: { params: { sandboxId: string } }
) {
  try {
    // In a real implementation, this would fetch specific telemetry for the selected sandbox
    // For now, return realistic mock data based on the selected sandbox

    const { sandboxId } = params

    // Simulate different telemetry for different sandboxes
    const baseValues = {
      cpu: 30 + Math.random() * 40,
      memory: 40 + Math.random() * 30,
      disk: 50 + Math.random() * 15
    }

    // Add some variation based on sandbox name
    const sandboxVariation = sandboxId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)

    const data = {
      cpu: Math.min(100, baseValues.cpu + (sandboxVariation % 20)),
      memory: Math.min(100, baseValues.memory + (sandboxVariation % 15)),
      disk: baseValues.disk + (sandboxVariation % 5),
      gpuMemoryUsed: 20 + Math.random() * 60,
      gpuMemoryTotal: 80,
      gpuTemperature: 65 + Math.random() * 20,
      timestamp: new Date().toISOString()
    }

    return NextResponse.json(data)
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch sandbox telemetry' },
      { status: 500 }
    )
  }
}