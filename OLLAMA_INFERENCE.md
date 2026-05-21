# Ollama Inference Runbook

This dashboard can route sandbox inference through OpenShell's `inference.local`
gateway to an OpenAI-compatible Ollama endpoint.

## Recommended WSL2 Path

For large local models, run Ollama inside WSL2 and point the OpenShell provider at
WSL localhost:

```bash
ollama serve
ollama pull nemotron-3-super:120b
ollama show nemotron-3-super:120b

openshell provider create \
  --name ollama-local \
  --type openai \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://127.0.0.1:11434/v1

# If the provider already exists:
openshell provider update ollama-local \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://127.0.0.1:11434/v1

openshell inference set \
  --no-verify \
  --provider ollama-local \
  --model nemotron-3-super:120b \
  --timeout 600
```

Use `openshell inference get` to verify the active route.

## Validated Local Models

These values are what Ollama reported on the WSL2 test host.

| Model | Size | Ollama context | Notes |
| --- | ---: | ---: | --- |
| `qwen2.5:7b` | 4.7 GB | 32768 | Fast fallback; enough for short cuFolio card requests after session reset. |
| `nemotron-3-super:120b` | 86 GB | 262144 | Fits on a 98 GB RTX 6000 Blackwell at Q4_K_M; much slower, but handles the cuFolio/OpenClaw prompt with far more context headroom. |

The `nemotron-3-super:120b` smoke test loaded entirely into RTX 6000 VRAM:

```text
size_vram: 94227902208
context_length: 262144
```

The end-to-end cuFolio sandbox chat test completed successfully with:

```text
model: inference/nemotron-3-super:120b
pending: false
answer: exact requested token
elapsed: about 91 seconds
```

## OpenClaw Context Behavior

OpenClaw reserves output/recovery tokens before building the prompt. With a 32768
token model and a 20000 token reserve, only about 12768 tokens remain for input
history. That is why long-running `inter-sandbox-chat` sessions can overflow even
when Ollama reports a 32k model context.

The sandbox inference live-apply path now publishes model metadata for known
Ollama models:

- `qwen2.5:7b`: `contextWindow=32768`, `maxTokens=2048`
- `qwen3.5:27b`: `contextWindow=32768`, `maxTokens=2048`
- `nemotron-3-super:120b`: `contextWindow=262144`, `maxTokens=8192`

If a sandbox has accumulated a very large chat transcript, reset or compact the
OpenClaw session before judging model health. In the cuFolio smoke test, an old
`inter-sandbox-chat` transcript caused a pre-inference context overflow; after
OpenClaw reset that session, the same WSL2 Ollama path answered correctly.

## Windows-Host Ollama Notes

Windows-host Ollama can be selected during onboarding and model discovery. From
WSL2, the dashboard probes:

- WSL localhost: `http://127.0.0.1:11434`
- WSL Windows-host gateway candidates from `/etc/resolv.conf` and `/proc/net/route`
- `host.docker.internal`
- Windows localhost through `curl.exe` / PowerShell interop

Useful environment overrides:

```bash
OPENSHELL_OLLAMA_BASE_URL=http://127.0.0.1:11434
OPENSHELL_OLLAMA_HOSTS=127.0.0.1,172.19.0.1
OPENSHELL_OLLAMA_PROBE_TIMEOUT_MS=2500
OPENSHELL_OLLAMA_WINDOWS_INTEROP=1
OPENSHELL_WINDOWS_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

During testing, Windows-host `qwen3.5:27b` could expose reasoning in the
OpenAI-compatible response while leaving `message.content` empty. The optional
proxy below converts OpenAI chat requests to Ollama native `/api/chat` with
`think:false` and streams early SSE events to avoid OpenClaw idle timeouts:

```bash
OLLAMA_PROXY_HOST=0.0.0.0 \
OLLAMA_PROXY_PORT=11435 \
OLLAMA_PROXY_UPSTREAM=http://172.18.16.1:11434 \
OLLAMA_PROXY_NUM_CTX=32768 \
node scripts/ollama-thinkless-openai-proxy.mjs

openshell provider update ollama-win \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://172.19.0.1:11435/v1
```

Prefer the WSL2-local path for the cuFolio demo unless the Windows-host model is
known to return normal OpenAI `message.content`.
