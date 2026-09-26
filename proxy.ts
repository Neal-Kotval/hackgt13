import { NextResponse, type NextRequest } from "next/server";
import { proxyRemoteRequest } from "./lib/remote-backend.mjs";

export async function proxy(request: NextRequest) {
  return (await proxyRemoteRequest(request)) ?? NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
