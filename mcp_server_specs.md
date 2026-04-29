# Uploaded MCP Server Requirements

This file is read by the LLM-assisted MCP install preflight. Treat it as the contract for making an uploaded server work with the Nemoclaw MCP broker.

## Runtime Contract

- Uploaded MCP servers must expose a valid Model Context Protocol server.
- Stdio servers must start from the configured command and args, speak MCP over stdin/stdout, initialize cleanly, and respond to tool discovery.
- HTTP servers must expose a streamable HTTP MCP endpoint. Do not convert an uploaded stdio server into an HTTP server unless the project already clearly supports it.
- The server must not require an interactive terminal, browser login flow, or long-running manual setup during launch.
- Startup logs must go to stderr, not stdout, so stdout remains available for stdio MCP messages.
- Secrets must be passed through env vars or server-side headers, never embedded in files, args, generated client handoffs, or logs.

## Broker Expectations

- The broker launches local stdio servers on the controller host using the stored command, args, env, and working project files.
- The broker validates a server by initializing it through the official MCP SDK and listing tools.
- A server with zero tools can pass only if that is expected and clearly explained; otherwise treat zero tools as a warning that may indicate a broken entrypoint.
- The broker must not expose launch commands, env vars, headers, or secrets to sandboxes. Sandboxes receive only broker access instructions.

## Python Uploads

- Create and use a per-server virtual environment inside the uploaded project root at `.venv`.
- Install `requirements.txt` with `.venv/bin/pip install -r requirements.txt` when present.
- Install `pyproject.toml` projects with `.venv/bin/pip install -e .` when present.
- Prefer the installed console script or `python -m package.module` when direct file execution causes package-relative import failures.
- Use `.venv/bin/python` for Python file or module launches after dependency bootstrap.
- Do not install Python dependencies globally.

## Node Uploads

- If `package-lock.json` is present, use `npm ci`.
- If only `package.json` is present, use `npm install`.
- Use `node` for JavaScript entry files unless the package provides a documented executable script.
- Do not require global npm installs for uploaded servers.

## Safe Repair Rules

- Only inspect and modify files inside the uploaded MCP server directory.
- Do not delete unrelated files.
- Do not edit generated dependency directories such as `.venv`, `node_modules`, `dist`, `build`, or `__pycache__`.
- Keep changes minimal and explain every changed file.
- If a required dependency, credential, external service, or runtime is missing and cannot be inferred safely, report the failure and describe what the user must provide.

## Preflight Output

A successful preflight should produce:

- The final command and args the broker should launch.
- Any env keys required, without secret values.
- Dependency bootstrap logs or a note that no bootstrap was required.
- MCP initialization and tool discovery result.
- A concise summary of any fixes applied.

A failed preflight should produce:

- The observed failure.
- Likely causes.
- Suggested fixes.
- Whether LLM-assisted repair can reasonably attempt a fix.
