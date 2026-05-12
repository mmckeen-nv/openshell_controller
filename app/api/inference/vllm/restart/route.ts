import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { HOST_PATH } from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)
const DOCKER_BIN = process.env.DOCKER_BIN || "docker"
const DEFAULT_VLLM_CONTAINER = process.env.OPENSHELL_CONTROL_VLLM_CONTAINER || "vllm-bigboy"

function configuredContainerAllowlist() {
  return new Set([
    DEFAULT_VLLM_CONTAINER,
    ...(process.env.OPENSHELL_CONTROL_VLLM_CONTAINERS || process.env.VLLM_CONTAINER_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ])
}

function validateContainerName(value: unknown) {
  const container = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_VLLM_CONTAINER
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) {
    throw new Error("invalid vLLM container name")
  }
  const allowlist = configuredContainerAllowlist()
  if (!allowlist.has(container) && !/^vllm(?:$|[_.-])/i.test(container)) {
    throw new Error("vLLM container restart is limited to vLLM-named or allowlisted containers")
  }
  return container
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const container = validateContainerName(body?.containerName ?? body?.container)
    const { stdout, stderr } = await execFileAsync(DOCKER_BIN, ["restart", container], {
      env: {
        ...process.env,
        PATH: HOST_PATH,
      },
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    })

    return NextResponse.json({
      ok: true,
      restarted: true,
      container,
      stdout: String(stdout).trim(),
      stderr: String(stderr).trim(),
      note: "vLLM container restart requested. The model may take time to reload before /v1/models is ready.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart vLLM container"
    return NextResponse.json({
      ok: false,
      restarted: false,
      error: message,
    }, { status: /invalid|limited|required/.test(message) ? 400 : 500 })
  }
}
