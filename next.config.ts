import type { NextConfig } from "next";

// ssh2 (web terminal bridge, lib/web-terminal.mjs) ships optional native crypto
// bindings that Turbopack cannot bundle; load it with Node's require instead.
const nextConfig: NextConfig = {
  serverExternalPackages: ["ssh2"],
};

export default nextConfig;
