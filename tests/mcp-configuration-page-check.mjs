import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'

const root = process.cwd()

const storePath = path.join(root, 'app/lib/mcpServerStore.ts')
const brokerStorePath = path.join(root, 'app/lib/mcpBrokerStore.ts')
const brokerClientPath = path.join(root, 'app/lib/mcpBrokerClient.ts')
const manifestPath = path.join(root, 'app/lib/sandboxMcpManifest.ts')
const privilegedFilesPath = path.join(root, 'app/lib/sandboxPrivilegedFiles.ts')
const routePath = path.join(root, 'app/api/mcp/route.ts')
const uploadRoutePath = path.join(root, 'app/api/mcp/upload/route.ts')
const registryRoutePath = path.join(root, 'app/api/mcp/registry/route.ts')
const brokerCapabilitiesRoutePath = path.join(root, 'app/api/mcp/broker/capabilities/route.ts')
const brokerCallRoutePath = path.join(root, 'app/api/mcp/broker/call/route.ts')
const sandboxMcpRoutePath = path.join(root, 'app/api/sandbox/[sandboxId]/mcp/route.ts')
const brokerUrlPath = path.join(root, 'app/lib/mcpBrokerUrl.ts')
const middlewarePath = path.join(root, 'middleware.ts')
const panelPath = path.join(root, 'app/components/McpConfigurationPanel.tsx')
const sidebarPath = path.join(root, 'app/components/Sidebar.tsx')
const sandboxListPath = path.join(root, 'app/components/SandboxList.tsx')
const pagePath = path.join(root, 'app/page.tsx')

const [storeSource, brokerStoreSource, brokerClientSource, manifestSource, privilegedFilesSource, routeSource, uploadRouteSource, registryRouteSource, brokerCapabilitiesRouteSource, brokerCallRouteSource, sandboxMcpRouteSource, brokerUrlSource, middlewareSource, panelSource, sidebarSource, sandboxListSource, pageSource] = await Promise.all([
  readFile(storePath, 'utf8'),
  readFile(brokerStorePath, 'utf8'),
  readFile(brokerClientPath, 'utf8'),
  readFile(manifestPath, 'utf8'),
  readFile(privilegedFilesPath, 'utf8'),
  readFile(routePath, 'utf8'),
  readFile(uploadRoutePath, 'utf8'),
  readFile(registryRoutePath, 'utf8'),
  readFile(brokerCapabilitiesRoutePath, 'utf8'),
  readFile(brokerCallRoutePath, 'utf8'),
  readFile(sandboxMcpRoutePath, 'utf8'),
  readFile(brokerUrlPath, 'utf8'),
  readFile(middlewarePath, 'utf8'),
  readFile(panelPath, 'utf8'),
  readFile(sidebarPath, 'utf8'),
  readFile(sandboxListPath, 'utf8'),
  readFile(pagePath, 'utf8'),
])

assert.match(storeSource, /export const MCP_SERVER_CATALOG/, 'MCP store must expose an install catalog')
assert.match(storeSource, /blendermcp\.org/, 'MCP catalog must include the requested BlenderMCP site')
assert.match(storeSource, /args:\s*\["blender-mcp"\]/, 'MCP catalog must install BlenderMCP via uvx blender-mcp')
assert.match(storeSource, /BASELINE_MCP_SERVER_IDS = \["memory"\]/, 'MCP dashboard should install Memory as the baseline test server')
assert.match(storeSource, /ensureBaselineMcpServers/, 'MCP store must seed baseline servers into dashboard state')
assert.match(storeSource, /mcp-servers\.json/, 'MCP installs must persist to dashboard state')
assert.match(storeSource, /accessMode/, 'MCP installs must persist sandbox access mode')
assert.match(storeSource, /allowedSandboxIds/, 'MCP installs must persist allowed sandbox lists')
assert.match(storeSource, /existing\?\.accessMode \|\| "disabled"/, 'MCP server access should default to disabled for sandboxes')
assert.match(storeSource, /export function buildMcpClientConfig/, 'MCP store must export client config JSON')
assert.match(storeSource, /mcpServers/, 'MCP client config must use the common mcpServers shape')
assert.match(brokerStoreSource, /mcp-broker-sessions\.json/, 'MCP broker sessions must persist server-side')
assert.match(brokerStoreSource, /verifySandboxMcpBrokerToken/, 'MCP broker must verify sandbox tokens server-side')
assert.match(brokerStoreSource, /listAllowedBrokerServers/, 'MCP broker must filter servers by access policy')
assert.match(brokerClientSource, /@modelcontextprotocol\/sdk\/client\/index\.js/, 'MCP broker must use the official SDK client')
assert.match(brokerClientSource, /StdioClientTransport/, 'MCP broker must support stdio servers')
assert.match(brokerClientSource, /StreamableHTTPClientTransport/, 'MCP broker must support streamable HTTP servers')
assert.match(brokerClientSource, /callBrokerServerTool/, 'MCP broker must forward allowed tool calls')
assert.match(manifestSource, /openshell_control_mcp\.md/, 'MCP sandbox manifest must use the requested filename')
assert.match(manifestSource, /syncSandboxMcpManifest/, 'MCP sandbox manifest must be syncable into a sandbox')
assert.match(manifestSource, /writeSandboxFilePrivileged/, 'MCP sandbox manifest must use a privileged write path for root-owned /sandbox mounts')
assert.match(privilegedFilesSource, /kubectl/, 'privileged sandbox file writes must use the OpenShell cluster control path')
assert.doesNotMatch(manifestSource, /allowedServers|renderServer|commandLine/, 'MCP sandbox handoff must not disclose server inventory or launch specs')
assert.match(manifestSource, /control plane enforces/, 'MCP sandbox handoff must explain broker-side enforcement')
assert.match(brokerCapabilitiesRouteSource, /listAllowedBrokerServers/, 'MCP broker capabilities must only list allowed servers')
assert.match(brokerCapabilitiesRouteSource, /listBrokerServerTools/, 'MCP broker capabilities must inspect allowed server tools')
assert.match(brokerCallRouteSource, /Requested MCP capability is unavailable/, 'MCP broker denied calls must not disclose blocked server names')
assert.match(brokerCallRouteSource, /callBrokerServerTool/, 'MCP broker call route must forward allowed calls')
assert.match(sandboxMcpRouteSource, /export async function POST/, 'Sandbox MCP route must write the broker handoff')
assert.match(sandboxMcpRouteSource, /action === "revoke"/, 'Sandbox MCP route must revoke broker handoff when MCP access is removed')
assert.match(sandboxMcpRouteSource, /syncBrokerNetworkAccess/, 'Sandbox MCP route must synchronize broker network access when MCP is enabled')
assert.match(sandboxMcpRouteSource, /revokeBrokerNetworkAccess/, 'Sandbox MCP route must remove broker network access when MCP is revoked')
assert.match(sandboxMcpRouteSource, /export async function GET/, 'Sandbox MCP route must preview the broker handoff')
assert.match(sandboxMcpRouteSource, /brokerBaseUrlForSandbox/, 'Sandbox MCP broker handoff must build a sandbox-routable broker URL')
assert.match(brokerUrlSource, /discoverOpenShellDockerGateway/, 'Sandbox MCP broker handoff must discover the active OpenShell network gateway')
assert.match(brokerUrlSource, /LOCAL_HOSTNAMES/, 'Sandbox MCP broker handoff must rewrite local-only browser origins')
assert.match(brokerUrlSource, /discoverSandboxProxyOrigin/, 'Sandbox MCP broker handoff must discover each sandbox proxy endpoint')
assert.match(brokerUrlSource, /HTTP_PROXY/, 'Sandbox MCP broker handoff must derive the proxy endpoint from sandbox environment')
assert.match(brokerUrlSource, /FALLBACK_SANDBOX_PROXY_ORIGIN/, 'Sandbox MCP broker handoff may keep a fallback for older OpenShell layouts')
assert.match(middlewareSource, /\/api\/mcp\/broker/, 'MCP broker endpoints must bypass dashboard cookie auth and rely on broker token auth')
assert.match(routeSource, /export async function GET/, 'MCP API must list server configuration')
assert.match(routeSource, /export async function POST/, 'MCP API must install and update server configuration')
assert.match(routeSource, /installMcpServer/, 'MCP API must support installing servers')
assert.match(routeSource, /uninstallMcpServer/, 'MCP API must support removing servers')
assert.match(routeSource, /updateMcpServerAccess/, 'MCP API must support access policy updates')
assert.match(uploadRouteSource, /request\.formData\(\)/, 'MCP upload API must accept multipart server bundles')
assert.match(uploadRouteSource, /writeDirectoryUpload/, 'MCP upload API must support directory uploads')
assert.match(uploadRouteSource, /writeArchiveUpload/, 'MCP upload API must support archive uploads')
assert.match(uploadRouteSource, /installMcpServer/, 'MCP upload API must install uploaded server bundles')
assert.match(registryRouteSource, /registry\.modelcontextprotocol\.io/, 'MCP registry search should default to the official registry')
assert.match(registryRouteSource, /\/v0\/servers/, 'MCP registry search should call the registry server list endpoint')
assert.match(registryRouteSource, /normalizeRegistryEntry/, 'MCP registry search should normalize results into installable entries')
assert.match(registryRouteSource, /packageInstall/, 'MCP registry search should support package-backed stdio installs')
assert.match(registryRouteSource, /remoteInstall/, 'MCP registry search should support remote HTTP installs')
assert.match(panelSource, /Install Custom Server/, 'MCP page must expose a custom server install action')
assert.match(panelSource, /Upload Server/, 'MCP custom server accordion must support uploaded server bundles')
assert.match(panelSource, /Choose Directory/, 'MCP custom server upload must accept directories')
assert.match(panelSource, /Choose Archive/, 'MCP custom server upload must accept archives')
assert.match(panelSource, /\/api\/mcp\/upload/, 'MCP custom server upload must call the upload API')
assert.match(panelSource, /uploadEntrypoint/, 'MCP custom server upload must collect an entrypoint')
assert.match(panelSource, /serverPayloadFromJson/, 'MCP page must parse edited server JSON')
assert.match(panelSource, /startEditingServer/, 'MCP installed server list must expose edit state')
assert.match(panelSource, /Server JSON/, 'MCP installed server editor must render an inline JSON file editor')
assert.match(panelSource, /Registry Search/, 'MCP page must expose official registry search')
assert.match(panelSource, /\/api\/mcp\/registry/, 'MCP page must query the registry search API')
assert.match(panelSource, /const REGISTRY_PAGE_SIZE = 4/, 'MCP registry search should page results four at a time')
assert.match(panelSource, /setRegistryResults\(\[\]\)/, 'MCP registry search should clear stale results before a new search')
assert.match(panelSource, /pagedRegistryResults/, 'MCP registry search should render paged results instead of the full result set')
assert.match(panelSource, /Preconfigured Servers/, 'MCP page should label catalog presets as preconfigured servers')
assert.match(panelSource, /aria-expanded=\{catalogOpen\}/, 'MCP preconfigured servers should render as an accordion')
assert.match(panelSource, /aria-expanded=\{customOpen\}/, 'MCP custom server form should render as an accordion')
assert.match(panelSource, /MCP Security/, 'MCP page must expose sandbox access controls')
assert.match(panelSource, /Allow All/, 'MCP security must support allow-all access')
assert.match(panelSource, /Allow Only/, 'MCP security must support allow-list access')
assert.match(panelSource, /Setup Guide/, 'MCP catalog cards should link out to app setup guides')
assert.match(panelSource, /Client JSON/, 'MCP page must surface generated client JSON')
assert.match(sandboxListSource, /Allowed MCP Server Access/, 'Sandbox page must expose allowed MCP server access accordion')
assert.match(sandboxListSource, /Sync Broker Config/, 'Sandbox MCP access controls must sync broker config')
assert.match(sandboxListSource, /hasOtherMcpAccess/, 'Sandbox MCP access controls must revoke broker config when no MCP servers remain')
assert.match(sandboxListSource, /\/sandbox\/openshell_control_mcp\.md/, 'Sandbox MCP access controls must name the manifest path')
assert.match(sandboxListSource, /sandboxCanAccessMcpServer/, 'Sandbox page must derive MCP access per sandbox')
assert.match(sandboxListSource, /MCP access allowed/, 'Sandbox cards must show a lit MCP access indicator')
assert.match(sandboxListSource, /Revoke/, 'Sandbox MCP access controls must include revoke')
assert.match(sidebarSource, /onMcpClick/, 'Sidebar must include MCP navigation callback')
assert.match(sidebarSource, /activeView === 'mcp'/, 'Sidebar must mark MCP view active')
assert.match(pageSource, /McpConfigurationPanel/, 'Dashboard must render MCP configuration panel')
assert.match(pageSource, /setActiveView\('mcp'\)/, 'Dashboard must switch to MCP view')

console.log('mcp-configuration-page-check: PASS MCP dashboard assertions')
