import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";

const directory = process.env.AGENTCLOUD_DATA_DIR || "/data";
await mkdir(directory, { recursive: true, mode: 0o700 });
const secretFile = path.join(directory, ".auth-secret");
try {
  await writeFile(secretFile, randomBytes(48).toString("base64url"), { mode: 0o600, flag: "wx" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
await chmod(secretFile, 0o600);
process.env.BETTER_AUTH_SECRET = (await readFile(secretFile, "utf8")).trim();
if (process.env.BETTER_AUTH_SECRET.length < 32) throw new Error("Local container auth secret is invalid");
process.env.BETTER_AUTH_URL ||= "http://127.0.0.1:3002";
process.env.AGENTCLOUD_REMOTE_BACKEND_URL = "";

let child;
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; child?.kill(signal); });
function run(args) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 || stopping ? resolve() : reject(new Error(`Container process exited (${code ?? signal})`)));
  });
}
await run(["scripts/auth-setup.mjs"]);
if (stopping) process.exit(0);
await run(["node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0", "--port", "3000"]);
