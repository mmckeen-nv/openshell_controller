import { NextRequest, NextResponse } from "next/server"
import { mintOAuthSessionJWT, sessionCookieOptionsForRequest } from "@/app/lib/controlAuth"
import { OAUTH_COOKIE_NAME } from "@/app/lib/auth/policy.mjs"

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  return Buffer.from(padded, "base64").toString("utf-8")
}

// Generic OAuth2 / OIDC callback handler. Reads IDP coordinates from the
// OAUTH_* env vars, falling back to the legacy MCPAUTH_* names so existing
// deployments don't need to rename anything.
function getIdpEnv(name: string) {
  const upper = name.toUpperCase()
  return (
    process.env[`OAUTH_${upper}`]
    || process.env[`MCPAUTH_${upper}`]
    || ""
  )
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const code = searchParams.get("code")
  const state = searchParams.get("state") || "/"

  if (!code) {
    return NextResponse.json({ ok: false, error: "Missing authorization code" }, { status: 400 })
  }

  const loginUrl = getIdpEnv("LOGIN_URL")
  const tokenUrl = `${loginUrl ? loginUrl.replace("/authorize", "") : "http://localhost:11000"}/token`
  const clientId = getIdpEnv("CLIENT_ID")
  const redirectUri = getIdpEnv("CALLBACK_URL")

  try {
    // Exchange authorization code for token
    const formData = new URLSearchParams()
    formData.append("grant_type", "authorization_code")
    formData.append("code", code)
    formData.append("redirect_uri", redirectUri)
    formData.append("client_id", clientId)

    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: formData.toString(),
    })

    const data = await response.json()
    if (!response.ok) {
      return NextResponse.json({ ok: false, error: data.error_description || "Token exchange failed" }, { status: response.status })
    }

    // Standard OIDC: extract email from the id_token JWT payload
    const idToken = data.id_token as string | undefined
    const accessToken = data.access_token as string | undefined

    let userEmail: string | null = null
    let scopes: string[] = []

    if (idToken) {
      try {
        const parts = idToken.split(".")
        if (parts.length >= 2) {
          const payload = JSON.parse(base64UrlDecode(parts[1]))
          userEmail = payload.email || payload.sub || null
        }
      } catch {
        // fall through to access token parsing
      }
    }

    // Fallback: parse scopes from access token payload
    if (accessToken) {
      try {
        const parts = accessToken.split(".")
        if (parts.length >= 2) {
          const payload = JSON.parse(base64UrlDecode(parts[1]))
          if (!userEmail && payload.email) userEmail = payload.email
          if (Array.isArray(payload.scopes)) scopes = payload.scopes
        }
      } catch {
        // ignore
      }
    }

    if (!userEmail) {
      return NextResponse.json({ ok: false, error: "User identity could not be retrieved from provider" }, { status: 500 })
    }

    // Mint the OAuth session JWT cookie using our shared secret.
    const oauthToken = await mintOAuthSessionJWT(userEmail, scopes)

    // Reconstruct target URL using the incoming Host header to ensure we
    // redirect to the correct domain/port (e.g. localhost:3000 instead of
    // 0.0.0.0:3000).
    const host = request.headers.get("host") || "localhost:3000"
    const protocol = request.headers.get("x-forwarded-proto") || request.nextUrl.protocol || "http"
    const cleanProtocol = protocol.endsWith(":") ? protocol.slice(0, -1) : protocol
    const baseUrl = `${cleanProtocol}://${host}`
    const targetUrl = new URL(state.startsWith("/") ? state : "/", baseUrl)
    const redirectResponse = NextResponse.redirect(targetUrl)
    redirectResponse.cookies.set(OAUTH_COOKIE_NAME, oauthToken, sessionCookieOptionsForRequest(request))

    return redirectResponse
  } catch (error) {
    console.error("OAuth callback error:", error)
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Internal server error during callback processing" },
      { status: 500 },
    )
  }
}
