import { spawn } from "node:child_process";
import { remoteBackendURL } from "../lib/remote-backend.mjs";

process.env.AGENTCLOUD_REMOTE_BACKEND_URL = process.env.AGENTCLOUD_URL || "";
const backend = remoteBackendURL();
if (!backend) throw new Error("AGENTCLOUD_URL is required. Run with the shared Doppler config.");
console.log(`Local frontend uses shared accounts and data at ${backend.origin}. Changes affect that backend.`);
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "3001", ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 1; });
