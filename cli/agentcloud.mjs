#!/usr/bin/env node
// Coordination client. It never launches an agent or executes remote commands.
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const command = args.shift();
const projectId = args.shift();
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!args[i].startsWith("--") || args[i + 1] === undefined) {
    console.error("Options require --name value");
    process.exit(1);
  }
  options[args[i].slice(2)] = args[i + 1];
}
const usage =
  'Usage: node cli/agentcloud.mjs <connect|context|service|task|handoff|peer|peer-status> <projectId> --agent <agentId> [options]\nSet AGENTCLOUD_TOKEN. Optional AGENTCLOUD_URL (default http://127.0.0.1:3000).\nservice: --name NAME --url URL\ntask: --task ID --status "in progress"\nhandoff: --to ID --title TITLE --summary TEXT --files path1,path2 --next TEXT\npeer: --from-session ID --to-session ID --text MESSAGE [--request-id ID]\npeer-status: --from-session ID --message ID\nconnect: --once true for a single heartbeat; otherwise remains connected.';
if (
  !["connect", "context", "service", "task", "handoff", "peer", "peer-status"].includes(command) ||
  !projectId ||
  !options.agent
) {
  console.error(usage);
  process.exit(1);
}
if (!process.env.AGENTCLOUD_TOKEN) {
  console.error(
    "AGENTCLOUD_TOKEN is required. Add an agent in the dashboard to receive a token.",
  );
  process.exit(1);
}
const base = process.env.AGENTCLOUD_URL || "http://127.0.0.1:3000";
const server = new URL(base);
if (
  server.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(server.hostname)
) {
  console.error(
    "Use HTTPS for non-loopback connections so the bearer token is encrypted.",
  );
  process.exit(1);
}
async function send(type) {
  const payload = { type, projectId, agentId: options.agent };
  if (type === "service")
    Object.assign(payload, { name: options.name, url: options.url });
  if (type === "task")
    Object.assign(payload, { taskId: options.task, status: options.status });
  if (type === "handoff")
    Object.assign(payload, {
      to: options.to,
      title: options.title,
      summary: options.summary,
      files: (options.files || "").split(",").filter(Boolean),
      next: options.next,
    });
  if (type === "peer") {
    if (!options['from-session'] || !options['to-session'] || !options.text) throw Error(usage);
    Object.assign(payload, {
      fromSessionId: options['from-session'],
      toSessionId: options['to-session'],
      text: options.text,
      requestId: options['request-id'] || randomUUID(),
    });
  }
  const target = new URL(['peer', 'peer-status'].includes(type) ? '/api/agent-peer-messages' : '/api/agent', base);
  if (type === 'peer-status') {
    if (!options['from-session'] || !options.message) throw Error(usage);
    target.searchParams.set('fromSessionId', options['from-session']);
    target.searchParams.set('messageId', options.message);
  }
  const response = await fetch(target, {
    method: type === 'peer-status' ? 'GET' : 'POST',
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.AGENTCLOUD_TOKEN}`,
    },
    ...(type === 'peer-status' ? {} : {body: JSON.stringify(payload)}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `HTTP ${response.status}`);
  return data;
}
try {
  const result = await send(command);
  if (command !== "connect") console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Connected ${options.agent} to ${projectId}. Coordination API only; remote shell and agent adapters are not implemented.`,
    );
    if (options.once !== "true") {
      let pending = false;
      const interval = setInterval(async () => {
        if (pending) return;
        pending = true;
        try {
          await send("heartbeat");
        } catch (error) {
          console.error(error.message);
        } finally {
          pending = false;
        }
      }, 15000);
      for (const signal of ["SIGINT", "SIGTERM"])
        process.on(signal, () => {
          clearInterval(interval);
          process.exit(0);
        });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
