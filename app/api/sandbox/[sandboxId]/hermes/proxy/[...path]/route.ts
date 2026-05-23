import { hermesDashboardProxyErrorResponse, proxyHermesDashboard } from '../shared'

async function handleRequest(
  request: Request,
  { params }: { params: Promise<{ sandboxId: string; path: string[] }> },
) {
  try {
    const { sandboxId, path } = await params
    return await proxyHermesDashboard(request, sandboxId, `/${path.join('/')}`)
  } catch (error) {
    return hermesDashboardProxyErrorResponse(error)
  }
}

export { handleRequest as DELETE, handleRequest as GET, handleRequest as HEAD, handleRequest as OPTIONS, handleRequest as PATCH, handleRequest as POST, handleRequest as PUT }
