import { NextResponse } from 'next/server'
import { getDefaultOpenClawDashboardInstanceId, getOpenClawDashboardUrl, probeOpenClawDashboard } from '../../../../lib/openshellHost'
import { getOpenClawInstanceIdForSandbox, resolveOpenClawInstance, resolveOpenClawInstanceForSandbox } from '../../../../lib/openclawInstances'
import { resolveRuntimeAuthority } from '../../../../lib/runtimeAuthority'

function parseInventoryCount(requestUrl: URL) {
  const raw = requestUrl.searchParams.get('inventoryCount')
  if (raw == null) return null
  const count = Number.parseInt(raw, 10)
  return Number.isFinite(count) && count >= 0 ? count : null
}

function firstHeaderValue(value: string | null) {
  return value?.split(',')[0]?.trim() || null
}

function buildBrowserGatewayUrl(request: Request, requestUrl: URL, proxiedUrl: string) {
  const forwardedProtocol = firstHeaderValue(request.headers.get('x-forwarded-proto'))
  const forwardedHost = firstHeaderValue(request.headers.get('x-forwarded-host'))
  const host = forwardedHost || request.headers.get('host') || requestUrl.host
  const protocol = (forwardedProtocol || requestUrl.protocol.replace(/:$/, '')) === 'https' ? 'wss:' : 'ws:'
  const wsProxyPort = process.env.OPENCLAW_DASHBOARD_WS_PROXY_PORT?.trim() || '3001'
  const gatewayHost = wsProxyPort
    ? new URL(`${requestUrl.protocol}//${host}`).hostname + `:${wsProxyPort}`
    : host

  return `${protocol}//${gatewayHost}${proxiedUrl}`
}

function buildLaunchUrl(request: Request, requestUrl: URL, proxiedUrl: string, bootstrapUrl: string | null) {
  const hashParams = new URLSearchParams({
    gatewayUrl: buildBrowserGatewayUrl(request, requestUrl, proxiedUrl),
  })

  if (!bootstrapUrl) return `${proxiedUrl}#${hashParams.toString()}`

  const bootstrap = new URL(bootstrapUrl)
  const browserHash = bootstrap.hash.startsWith('#') ? bootstrap.hash.slice(1) : bootstrap.hash
  bootstrap.hash = ''

  new URLSearchParams(browserHash).forEach((value, key) => {
    hashParams.set(key, value)
  })

  const params = new URLSearchParams({
    path: '/',
    bootstrapUrl: bootstrap.toString(),
  })

  return `${proxiedUrl}?${params.toString()}#${hashParams.toString()}`
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url)
  const sandboxId = requestUrl.searchParams.get('sandboxId')
  const requestedInstanceId = requestUrl.searchParams.get('instanceId')
  const inventoryCount = parseInventoryCount(requestUrl)
  const mappedSandboxInstanceId = getOpenClawInstanceIdForSandbox(sandboxId)
  const instance = requestedInstanceId
    ? resolveOpenClawInstance(requestedInstanceId)
    : resolveOpenClawInstanceForSandbox(sandboxId)
  const authority = resolveRuntimeAuthority({
    sandboxId,
    instanceId: requestedInstanceId,
  })
  const probe = await probeOpenClawDashboard(authority.openclaw.id)
  const instanceQualifiedProxyBase = `/api/openshell/instances/${encodeURIComponent(instance.id)}/dashboard/proxy`
  const zeroInventoryMappedDashboard = Boolean(
    inventoryCount === 0 &&
    sandboxId &&
    authority.bridgeActive &&
    probe.reachable
  )
  const truthState = zeroInventoryMappedDashboard
    ? 'degraded'
    : probe.bootstrapAuthority === 'tokenized-cli'
      ? 'tokenized'
      : authority.bridgeActive
        ? 'bridged'
        : 'verified'

  const proxiedUrl = authority.explicitInstanceOverride ? instanceQualifiedProxyBase : '/api/openshell/dashboard/proxy'
  const launchUrl = buildLaunchUrl(request, requestUrl, proxiedUrl, probe.bootstrapUrl)

  return NextResponse.json({
    ok: true,
    sandboxId,
    sandboxInstanceId: mappedSandboxInstanceId,
    instanceId: instance.id,
    inventoryCount,
    truthState,
    degraded: zeroInventoryMappedDashboard,
    authority: {
      requestedSandboxId: authority.requestedSandboxId,
      resolvedSandboxId: authority.resolvedSandboxId,
      sandboxAuthority: authority.sandboxAuthority,
      authorityMode: authority.authorityMode,
      provenance: authority.provenance,
      bridgeActive: authority.bridgeActive,
      bridgeReason: authority.bridgeReason,
      requestedInstanceId: authority.requestedInstanceId,
      instanceId: authority.openclaw.id,
      sandboxInstanceId: mappedSandboxInstanceId,
      explicitInstanceOverride: authority.explicitInstanceOverride,
      usedMappedSandboxInstance: authority.usedMappedSandboxInstance,
    },
    defaultInstanceId: getDefaultOpenClawDashboardInstanceId(),
    dashboardUrl: getOpenClawDashboardUrl(authority.openclaw.id),
    bootstrapUrl: probe.bootstrapUrl,
    bootstrapTokenPresent: probe.bootstrapTokenPresent,
    bootstrapSource: probe.bootstrapSource,
    bootstrapAuthority: probe.bootstrapAuthority,
    proxiedUrl,
    launchUrl,
    instanceQualifiedProxiedUrl: instanceQualifiedProxyBase,
    openInNewTab: true,
    loopbackOnly: authority.openclaw.loopbackOnly,
    reachable: probe.reachable,
    upstreamStatus: probe.status,
    upstreamStatusText: probe.statusText,
    listenerPresent: probe.listenerPresent,
    listenerSummary: probe.listenerSummary,
    note: zeroInventoryMappedDashboard
      ? 'Degraded truth: live OpenShell inventory is zero, but a bridged OpenClaw dashboard upstream is still reachable. Treat this dashboard as a fallback operator surface, not proof that the sandbox currently exists.'
      : probe.bootstrapAuthority === 'tokenized-cli'
        ? 'Tokenized bootstrap available: the bridge resolved a dashboard URL from `openclaw dashboard --no-open`, so the proxy can carry the real OpenClaw session contract instead of treating raw loopback fetch as sufficient truth.'
        : authority.bridgeActive
          ? authority.bridgeReason || 'Bridge-active: this dashboard action is using an explicit upstream OpenClaw bridge instead of assuming same-lane loopback ownership.'
          : authority.openclaw.loopbackOnly
            ? 'OpenClaw Dashboard is loopback-only on the host, so the web UI uses a local proxy route to expose it.'
            : 'OpenClaw Dashboard is reachable directly for this instance.'
  })
}
