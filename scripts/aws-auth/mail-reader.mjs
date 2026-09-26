import http from "node:http";
import { readdir, readFile } from "node:fs/promises";

const directory = `${process.env.AGENTCLOUD_DATA_DIR || "/var/lib/agentcloud"}/mail`;
const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1:3101");
    const email = url.searchParams.get("email");
    if (request.method !== "GET" || url.pathname !== "/latest" || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      response.writeHead(400).end();
      return;
    }
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort().reverse();
    for (const name of names) {
      const message = JSON.parse(await readFile(`${directory}/${name}`, "utf8"));
      if (message.to?.toLowerCase() !== email.toLowerCase() || message.subject !== "Verify your AgentCloud email") continue;
      const link = message.text?.match(/https?:\/\/[^\s]+/g)?.find((value) => value.includes("/api/auth/verify-email"));
      if (!link) continue;
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end(`${link}\n`);
      return;
    }
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(3101, "127.0.0.1");
