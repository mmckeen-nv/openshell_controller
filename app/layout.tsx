import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "OpenShell/NemoClaw Dashboard",
  description: "Control plane dashboard for OpenShell and NemoClaw",
  icons: {
    icon: "/favicon.ico",
    shortcut: "/favicon.ico",
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" data-theme="dark">
      <body>{children}</body>
    </html>
  )
}
