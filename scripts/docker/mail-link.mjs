import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const email = process.argv[2];
if (!email || !email.includes("@")) throw new Error("Provide your account email");
const directory = path.join(process.env.AGENTCLOUD_DATA_DIR || "/data", "mail");
const files = await readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
for (const file of files.sort().reverse()) {
  const message = JSON.parse(await readFile(path.join(directory, file), "utf8"));
  if (message.to !== email) continue;
  const link = message.text.match(/https?:\/\/[^\s]+/)?.[0];
  if (link) { console.log(link); process.exit(0); }
}
console.error("No captured message found for this account.");
process.exitCode = 1;
