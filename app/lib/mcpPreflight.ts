import { listBrokerServerTools } from "./mcpBrokerClient"
import type { McpServerInstall } from "./mcpServerStore"

export type McpPreflightResult = {
  ok: boolean
  checkedAt: string
  toolCount: number
  tools: string[]
  durationMs: number
  error?: string
  diagnosis: {
    summary: string
    likelyCauses: string[]
    suggestedFixes: string[]
    confidence: "low" | "medium" | "high"
  }
}

function commandLine(server: Pick<McpServerInstall, "command" | "args">) {
  return [server.command, ...(server.args || [])].filter(Boolean).join(" ")
}

function diagnoseFailure(server: Pick<McpServerInstall, "command" | "args" | "transport">, error: string): McpPreflightResult["diagnosis"] {
  const joinedArgs = (server.args || []).join(" ")
  const command = commandLine(server)
  const likelyCauses: string[] = []
  const suggestedFixes: string[] = []
  let confidence: McpPreflightResult["diagnosis"]["confidence"] = "medium"

  if (/attempted relative import with no known parent package/i.test(error)) {
    confidence = "high"
    likelyCauses.push("The Python server was launched as a raw file even though it uses package-relative imports.")
    suggestedFixes.push("Switch the upload launch mode to Python module and use an entrypoint like package_name.server.")
    suggestedFixes.push("Alternatively use Console script if pyproject.toml defines a [project.scripts] entry.")
  }

  if (/unexpected keyword argument ['\"]description['\"]/i.test(error) || /FastMCP\.__init__\(\).*description/i.test(error)) {
    confidence = "high"
    likelyCauses.push("The server code targets a different MCP SDK FastMCP constructor than the one installed in the upload environment.")
    suggestedFixes.push("Remove the description= argument from FastMCP(...) or pin the mcp dependency to a version that supports it.")
  }

  if (/No module named ['\"][^'\"]+['\"]|ModuleNotFoundError/i.test(error)) {
    confidence = confidence === "high" ? "high" : "medium"
    likelyCauses.push("A Python dependency is missing from requirements.txt or pyproject.toml.")
    suggestedFixes.push("Add the missing package to project dependencies, then upload again so the virtualenv is rebuilt.")
  }

  if (/command not found|ENOENT|spawn .* ENOENT/i.test(error)) {
    confidence = "high"
    likelyCauses.push("The configured command is not available on the controller host PATH.")
    suggestedFixes.push("Use an installed command, an absolute path, or upload a bundled server so OpenShell Control can create the runtime environment.")
  }

  if (/ECONNREFUSED|ENOTFOUND|404 Not Found|fetch failed|connect/i.test(error) && server.transport === "http") {
    likelyCauses.push("The remote MCP endpoint did not answer as a streamable HTTP MCP server.")
    suggestedFixes.push("Confirm the endpoint URL points at the MCP route, not just the service root.")
  }

  if (/^-m\s+\S+/.test(joinedArgs) || joinedArgs.includes(" -m ")) {
    suggestedFixes.push("Confirm the Python module path is importable after dependency installation.")
  }

  if (likelyCauses.length === 0) {
    likelyCauses.push("The server process did not complete MCP initialization and tool discovery.")
    suggestedFixes.push("Run the command manually on the controller host and check stderr for startup errors.")
    if (/\.py(\s|$)/.test(command)) {
      suggestedFixes.push("If this is a Python package, try Python module or Console script launch mode instead of File.")
    }
    confidence = "low"
  }

  return {
    summary: `Preflight could not list MCP tools for: ${command}`,
    likelyCauses,
    suggestedFixes,
    confidence,
  }
}

export async function preflightMcpServer(server: McpServerInstall): Promise<McpPreflightResult> {
  const checkedAt = new Date().toISOString()
  const startedAt = Date.now()
  try {
    const tools = await listBrokerServerTools(server)
    return {
      ok: true,
      checkedAt,
      toolCount: tools.length,
      tools: tools.slice(0, 12).map((tool) => tool.name),
      durationMs: Date.now() - startedAt,
      diagnosis: {
        summary: tools.length > 0
          ? `Preflight listed ${tools.length} MCP tool${tools.length === 1 ? "" : "s"}.`
          : "Preflight connected but the server did not report any tools.",
        likelyCauses: [],
        suggestedFixes: tools.length > 0 ? [] : ["Confirm this server is expected to expose tools rather than only resources or prompts."],
        confidence: "high",
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "MCP server preflight failed"
    return {
      ok: false,
      checkedAt,
      toolCount: 0,
      tools: [],
      durationMs: Date.now() - startedAt,
      error: message,
      diagnosis: diagnoseFailure(server, message),
    }
  }
}
