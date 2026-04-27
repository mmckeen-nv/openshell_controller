export function buildSandboxTelemetry(sandboxId: string) {
  const baseValues = {
    cpu: 30 + Math.random() * 40,
    memory: 40 + Math.random() * 30,
    disk: 50 + Math.random() * 15,
  }

  const sandboxVariation = sandboxId.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0)

  return {
    cpu: Math.min(100, baseValues.cpu + (sandboxVariation % 20)),
    memory: Math.min(100, baseValues.memory + (sandboxVariation % 15)),
    disk: baseValues.disk + (sandboxVariation % 5),
    gpuMemoryUsed: 20 + Math.random() * 60,
    gpuMemoryTotal: 80,
    gpuTemperature: 65 + Math.random() * 20,
    timestamp: new Date().toISOString(),
  }
}
