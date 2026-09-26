import type { Metadata } from "next";
import "./tokens.css";
import "./globals.css";
import { SiteMotion } from "@/components/site-motion";
import { WebsiteShell } from "@/components/site-shell";
export const metadata: Metadata = {
  title: "AgentCloud — a workspace for your agent team",
  description:
    "Coordinate agents, shared services, and handoffs in one persistent project.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body><SiteMotion><WebsiteShell>{children}</WebsiteShell></SiteMotion></body>
    </html>
  );
}
