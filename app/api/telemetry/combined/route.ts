import { NextResponse } from "next/server"

export async function GET() {
  const combinedTelemetry = {
    cpu: Math.random() * 30 + 30,
    memory: Math.random() * 25 + 40,
    disk: Math.random() * 15 + 50,
    gpuMemoryUsed: Math.random() * 60 + 20,
    gpuMemoryTotal: 80,
    gpuTemperature: Math.random() * 20 + 65,
    timestamp: new Date().toISOString()
  }

  return NextResponse.json(combinedTelemetry)
}
