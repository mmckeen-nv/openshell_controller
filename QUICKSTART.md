# Quick Start Guide

## Installation & Setup

1. **Navigate to project directory:**
```bash
cd /path/to/openshell_controller
```

2. **Install dependencies:**
```bash
./install.sh
```

3. **Start the development server:**
```bash
npm run dev
```

4. **Open your browser:**
```
http://localhost:3000
```

## What You'll See

- **Sandbox inventory** from the OpenShell gateway
- **Operator terminal** and OpenClaw dashboard proxy links
- **Inference settings** for OpenAI-compatible providers, Ollama, NIM, and vLLM
- **Ollama model discovery** across WSL2 localhost and optional Windows-host Ollama
- **MCP broker settings** and per-sandbox MCP access controls

## Ollama Smoke Test

For WSL2 demo hosts, run Ollama in WSL2:

```bash
ollama serve
ollama pull qwen2.5:7b
ollama pull nemotron-3-super:120b
```

Configure the gateway:

```bash
openshell provider update ollama-local \
  --credential OPENAI_API_KEY=ollama \
  --config OPENAI_BASE_URL=http://127.0.0.1:11434/v1

openshell inference set \
  --no-verify \
  --provider ollama-local \
  --model nemotron-3-super:120b \
  --timeout 600
```

`qwen2.5:7b` reports a 32768 token context. `nemotron-3-super:120b` reports a
262144 token context and needs about 94 GB of RTX 6000 VRAM at Q4_K_M.

## Troubleshooting

### Dashboard won't load
- Check if port 3000 is already in use: `lsof -ti:3000`
- Kill process: `kill -9 $(lsof -ti:3000)`
- Restart the server

### API endpoints returning errors
- Check `openshell sandbox list`
- Check that the OpenShell gateway container is running
- Check browser console and server logs for specific errors

### Ollama models do not appear
- Confirm WSL2 Ollama is reachable: `curl http://127.0.0.1:11434/api/tags`
- If using Windows-host Ollama, confirm it is reachable from WSL2 through the
  detected host gateway or Windows interop
- Review `OLLAMA_INFERENCE.md` for the supported environment overrides

### Dependencies not installing
- Make sure you're running Node.js 20 or later
- Clear npm cache: `npm cache clean --force`
- Try reinstalling: `rm -rf node_modules package-lock.json && npm install`

## Support

For issues or questions:
- Check the main README.md
- Review API route files for endpoint details
- Check browser console for errors
