import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { HOST_PATH } from "@/app/lib/hostCommands"

const execFileAsync = promisify(execFile)

const DOCKER_BIN = process.env.DOCKER_BIN || "docker"
const DEFAULT_VLLM_CONTAINER = process.env.OPENSHELL_CONTROL_VLLM_CONTAINER || "vllm-bigboy"
const DEFAULT_VLLM_IMAGE = "nvcr.io/nvidia/vllm:26.03.post1-py3"
const DEFAULT_VLLM_MODEL = "vllm-local"
const DEFAULT_VLLM_MAX_MODEL_LEN = "32768"
const DEFAULT_VLLM_ORIGINAL_CONTEXT = 32768
const DEFAULT_VLLM_YARN_FACTOR = 1

const DTYPES = new Set(["auto", "bfloat16", "float16", "float", "float32", "half"])
const KV_CACHE_DTYPES = new Set(["auto", "bfloat16", "fp8", "fp8_ds_mla", "fp8_e4m3", "fp8_e5m2", "fp8_inc"])
const TOOL_CALL_PARSERS = new Set(["", "hermes", "llama3_json", "mistral", "openai", "qwen3_coder"])

function configuredContainerAllowlist() {
  return new Set([
    DEFAULT_VLLM_CONTAINER,
    ...(process.env.OPENSHELL_CONTROL_VLLM_CONTAINERS || process.env.VLLM_CONTAINER_ALLOWLIST || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ])
}

function text(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback
}

function validateContainerName(value: unknown) {
  const container = text(value, DEFAULT_VLLM_CONTAINER)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new Error("invalid vLLM container name")
  const allowlist = configuredContainerAllowlist()
  if (!allowlist.has(container) && !/^vllm(?:$|[_.-])/i.test(container)) {
    throw new Error("vLLM container apply is limited to vLLM-named or allowlisted containers")
  }
  return container
}

function validateImage(value: unknown) {
  const image = text(value, DEFAULT_VLLM_IMAGE)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) throw new Error("invalid vLLM image")
  return image
}

function validateModel(value: unknown) {
  const model = text(value, DEFAULT_VLLM_MODEL)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(model)) throw new Error("invalid vLLM model id")
  return model
}

function validateGpuDevice(value: unknown) {
  const gpuDevice = text(value, "0")
  if (!/^\d+(?:,\d+)*$/.test(gpuDevice)) throw new Error("GPU device must be a comma-separated list of device ids")
  return gpuDevice
}

function validatePort(value: unknown, fallback: string) {
  const port = Number.parseInt(text(value, fallback), 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535")
  return String(port)
}

function validateInteger(value: unknown, fallback: string, label: string, min: number, max: number) {
  const parsed = Number.parseInt(text(value, fallback), 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return String(parsed)
}

function validateOptionalInteger(value: unknown, label: string, min: number, max: number) {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) return ""
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}`)
  return String(parsed)
}

function validateMemoryUtilization(value: unknown) {
  const parsed = Number.parseFloat(text(value, "0.85"))
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 0.99) throw new Error("GPU memory utilization must be between 0.1 and 0.99")
  return String(parsed)
}

function validateEnum(value: unknown, fallback: string, allowed: Set<string>, label: string) {
  const selected = text(value, fallback)
  if (!allowed.has(selected)) throw new Error(`unsupported ${label}: ${selected}`)
  return selected
}

function validateYarnFactor(value: unknown) {
  const parsed = Number.parseFloat(text(value, String(DEFAULT_VLLM_YARN_FACTOR)))
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 16) throw new Error("YaRN factor must be between 1 and 16")
  return parsed
}

function dockerEnv() {
  return { ...process.env, PATH: HOST_PATH }
}

async function removeExistingContainer(container: string) {
  try {
    await execFileAsync(DOCKER_BIN, ["rm", "-f", container], {
      env: dockerEnv(),
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr || "")
    if (!/No such container/i.test(stderr)) throw error
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const container = validateContainerName(body?.containerName ?? body?.container)
    const image = validateImage(body?.image)
    const model = validateModel(body?.model)
    const gpuDevice = validateGpuDevice(body?.gpuDevice)
    const hostPort = validatePort(body?.hostPort, "8000")
    const containerPort = validatePort(body?.containerPort, "8000")
    const tensorParallelSize = validateInteger(body?.tensorParallelSize, "1", "tensor parallel size", 1, 64)
    const maxModelLen = validateInteger(body?.maxModelLen, DEFAULT_VLLM_MAX_MODEL_LEN, "max model len", 1024, 262144)
    const gpuMemoryUtilization = validateMemoryUtilization(body?.gpuMemoryUtilization)
    const dtype = validateEnum(body?.dtype, "bfloat16", DTYPES, "dtype")
    const kvCacheDtype = validateEnum(body?.kvCacheDtype, "fp8", KV_CACHE_DTYPES, "KV cache dtype")
    const maxNumBatchedTokens = validateOptionalInteger(body?.maxNumBatchedTokens, "max batched tokens", 1, 262144)
    const maxNumSeqs = validateOptionalInteger(body?.maxNumSeqs, "max seqs", 1, 4096)
    const toolCallParser = validateEnum(body?.toolCallParser, "hermes", TOOL_CALL_PARSERS, "tool parser")
    const allowLongMaxModelLen = bool(body?.allowLongMaxModelLen, false)
    const enableYarnScaling = bool(body?.enableYarnScaling, false)
    const yarnFactor = validateYarnFactor(body?.yarnFactor)
    const originalContext = Number.parseInt(
      validateInteger(body?.originalContext, String(DEFAULT_VLLM_ORIGINAL_CONTEXT), "original context", 1024, 262144),
      10,
    )
    const enableChunkedPrefill = bool(body?.enableChunkedPrefill, true)
    const enableAutoToolChoice = bool(body?.enableAutoToolChoice, true)
    const calculateKvScales = bool(body?.calculateKvScales, false)
    const hfCacheDir = `${process.env.HOME || "/root"}/.cache/huggingface`

    const runArgs = [
      "run", "-d",
      "--name", container,
      "--runtime", "nvidia",
      "--gpus", `"device=${gpuDevice}"`,
      "--ipc=host",
      "--shm-size=64g",
      "--ulimit", "memlock=-1",
      "--ulimit", "stack=67108864",
      "-e", `CUDA_VISIBLE_DEVICES=${gpuDevice}`,
      "-e", "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True",
      ...(allowLongMaxModelLen ? ["-e", "VLLM_ALLOW_LONG_MAX_MODEL_LEN=1"] : []),
      "-v", `${hfCacheDir}:/root/.cache/huggingface`,
      "-p", `${hostPort}:${containerPort}`,
      "--restart", "unless-stopped",
      image,
      "python3", "-m", "vllm.entrypoints.openai.api_server",
      "--model", model,
      "--host", "0.0.0.0",
      "--port", containerPort,
      "--tensor-parallel-size", tensorParallelSize,
    ]

    if (enableYarnScaling) {
      runArgs.push("--hf-overrides", JSON.stringify({
        max_position_embeddings: Number.parseInt(maxModelLen, 10),
        rope_scaling: {
          type: "yarn",
          factor: yarnFactor,
          original_max_position_embeddings: originalContext,
        },
      }))
    }

    runArgs.push(
      "--max-model-len", maxModelLen,
      "--gpu-memory-utilization", gpuMemoryUtilization,
      "--dtype", dtype,
    )

    if (kvCacheDtype !== "auto") runArgs.push("--kv-cache-dtype", kvCacheDtype)
    if (maxNumBatchedTokens) runArgs.push("--max-num-batched-tokens", maxNumBatchedTokens)
    if (maxNumSeqs) runArgs.push("--max-num-seqs", maxNumSeqs)
    if (enableChunkedPrefill) runArgs.push("--enable-chunked-prefill")
    if (enableAutoToolChoice) {
      runArgs.push("--enable-auto-tool-choice")
      if (toolCallParser) runArgs.push("--tool-call-parser", toolCallParser)
    }
    if (calculateKvScales && kvCacheDtype.startsWith("fp8")) runArgs.push("--calculate-kv-scales")

    await removeExistingContainer(container)
    const { stdout, stderr } = await execFileAsync(DOCKER_BIN, runArgs, {
      env: dockerEnv(),
      timeout: 120000,
      maxBuffer: 4 * 1024 * 1024,
    })

    return NextResponse.json({
      ok: true,
      applied: true,
      container,
      image,
      model,
      hostPort,
      containerPort,
      stdout: String(stdout).trim(),
      stderr: String(stderr).trim(),
      note: "vLLM container recreated. The model may take time to load before /v1/models is ready.",
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to apply vLLM container configuration"
    return NextResponse.json(
      { ok: false, applied: false, error: message },
      { status: /invalid|limited|required|must|unsupported|between/.test(message) ? 400 : 500 },
    )
  }
}
