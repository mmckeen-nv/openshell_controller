import { proxyErrorResponse, proxyOpenClawDashboard } from '../shared'

export async function GET(request: Request) {
  try {
    return await proxyOpenClawDashboard(request)
  } catch (error) {
    return proxyErrorResponse(error)
  }
}
