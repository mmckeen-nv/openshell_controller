import { proxyErrorResponse, proxyOpenClawDashboard } from '../../../../dashboard/proxy/shared'

export async function GET(request: Request) {
  try {
    return await proxyOpenClawDashboard(request)
  } catch (error) {
    return proxyErrorResponse(error)
  }
}
