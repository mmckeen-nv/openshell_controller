import { NextResponse } from "next/server"
import { buildOpenApiSpec } from "@/app/lib/openapiSpec"

function baseUrlFromRequest(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const host = forwardedHost || request.headers.get("host")
  if (!host) return ""

  const protocol = forwardedProto || new URL(request.url).protocol.replace(":", "") || "http"
  return `${protocol}://${host}`
}

export async function GET(request: Request) {
  return NextResponse.json(buildOpenApiSpec(baseUrlFromRequest(request)))
}
