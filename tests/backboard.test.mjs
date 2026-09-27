import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { backboardConfig, createBackboardClient, projectMemoryTools } from "../lib/backboard.mjs";
import { augmentCodexTurn, ensureAgentThread, ensureProjectAssistant, environmentMemory, executeProjectTool, openBackboardDb, projectMemoryStatus, setEnvironmentMemory } from "../lib/backboard-memory.mjs";
import { createCodexSessionService } from "../lib/codex-sessions.mjs";

const key = "bb-test-key-not-real";

function client(handler, env = { BACKBOARD_API_KEY: key }) {
  const calls = [];
  const api = createBackboardClient({
    env,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return handler(url, init);
    },
  });
  return { api, calls };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Backboard stays off when no key is set and never touches the network", async () => {
  assert.equal(projectMemoryStatus({}).enabled, false);
  assert.equal(backboardConfig({}).configured, false);
  let called = false;
  const api = createBackboardClient({ env: {}, fetchImpl: async () => { called = true; return json({}); } });
  await assert.rejects(() => api.createAssistant("alto"), /not configured/);
  assert.equal(called, false);
  const db = openBackboardDb(path.join(mkdtempSync(path.join(os.tmpdir(), "alto-bb-")), "backboard.sqlite"));
  assert.deepEqual(await ensureProjectAssistant(db, api, "project-1", "alto"), { enabled: false });
});

test("a configured client uses HTTPS, the API key header, and does not follow redirects", async () => {
  assert.throws(() => backboardConfig({ BACKBOARD_API_KEY: key, BACKBOARD_API_BASE: "http://app.backboard.io" }), /HTTPS/);
  const { api, calls } = client(() => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
  await assert.rejects(() => api.createAssistant("alto"), /redirected/);
  assert.equal(calls[0].url, "https://app.backboard.io/api/assistants");
  assert.equal(new Headers(calls[0].init.headers).get("X-API-Key"), key);
  assert.equal(calls[0].init.redirect, "manual");
  const leaked = client(() => json({ message: `leaked ${key}` }, 500));
  await assert.rejects(() => leaked.api.createAssistant("alto"), (error) => {
    assert.equal(error.message.includes(key), false);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("one project assistant and one agent thread are created once and then reused", async () => {
  const { api, calls } = client((url) => {
    if (String(url).endsWith("/assistants")) return json({ assistant_id: "assistant1" });
    if (String(url).endsWith("/threads")) return json({ thread_id: "thread0001" });
    return json({}, 404);
  });
  const db = openBackboardDb(path.join(mkdtempSync(path.join(os.tmpdir(), "alto-bb-")), "backboard.sqlite"));
  const first = await ensureProjectAssistant(db, api, "project-1", "Campus");
  const second = await ensureProjectAssistant(db, api, "project-1", "Campus");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.assistantId, "assistant1");
  const thread = await ensureAgentThread(db, api, "project-1", "agent-1");
  const again = await ensureAgentThread(db, api, "project-1", "agent-1");
  assert.equal(thread.created, true);
  assert.equal(again.threadId, "thread0001");
  assert.equal(calls.filter((call) => call.url.endsWith("/assistants")).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith("/threads")).length, 1);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.tools.length, projectMemoryTools.length);
  assert.equal(body.tools.some((tool) => tool.function.parameters.properties?.host), false);
});

test("memory tools save and search facts, and computer tools do not run", async () => {
  const { api, calls } = client((url) => json({ memories: [{ content: "login route is on auth-fix" }] }));
  await assert.rejects(() => executeProjectTool(api, "assistant1", "write_project_memory", { summary: "token sk-abcdefghij" }), /secret/);
  const saved = await executeProjectTool(api, "assistant1", "write_project_memory", {
    summary: "Added the login route",
    branch: "auth-fix",
    next: "Run tests",
  });
  assert.equal(saved.saved, true);
  assert.match(calls[0].url, /\/assistants\/assistant1\/memories$/);
  const found = await executeProjectTool(api, "assistant1", "search_project_memory", { query: "login" });
  assert.equal(found.memories[0].content, "login route is on auth-fix");
  for (const name of ["git_snapshot", "read_file", "run_command"]) {
    const result = await executeProjectTool(api, "assistant1", name, { command: "whoami", path: "README.md" });
    assert.equal(result.available, false);
  }
  await assert.rejects(() => executeProjectTool(api, "assistant1", "run_command", { command: "whoami", runBoxId: "other-box" }), /cannot choose a computer/);
  assert.equal(calls.length, 2);
});

test("hosted chat routes stay independent, and Codex uses memory only through the server service", () => {
  const root = new URL("..", import.meta.url);
  for (const file of ["app/api/chat/route.ts", "app/api/codex-sessions/route.ts", "app/api/codex-sessions/[id]/route.ts", "lib/project-chat.ts"]) {
    const source = readFileSync(new URL(file, root), "utf8");
    assert.equal(source.includes("backboard"), false, file);
  }
  const service = readFileSync(new URL("lib/codex-service.ts", root), "utf8");
  assert.match(service, /augmentCodexTurn/);
});

test("a Codex turn includes shared memory and still sends when Backboard fails", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "alto-bb-turn-"));
  const file = path.join(dir, "backboard.sqlite");
  const env = { BACKBOARD_API_KEY: key, AGENTCLOUD_DATA_DIR: dir };
  let saved = "";
  const box = "11111111-1111-4111-8111-111111111111";
  const untouched = await augmentCodexTurn({
    projectId: "project-1",
    agentId: "agent-1",
    text: "Run the login tests",
    runBoxId: box,
    env,
    file,
    fetchImpl: async () => { throw new Error("should not fetch"); },
  });
  assert.equal(untouched.text, "Run the login tests");
  assert.equal(environmentMemory(file, box).enabled, false);
  setEnvironmentMemory(file, box, true);
  const memory = await augmentCodexTurn({
    projectId: "project-1",
    agentId: "agent-1",
    text: "Run the login tests",
    runBoxId: box,
    env,
    file,
    fetchImpl: async (url, init) => {
      const target = String(url);
      if (target.endsWith("/assistants")) return json({ assistant_id: "assistant1" });
      if (target.endsWith("/threads")) return json({ thread_id: "thread0001" });
      if (target.endsWith("/memories/search")) return json({ memories: [{ content: "Login route is on auth-fix" }] });
      if (target.endsWith("/memories")) { saved = JSON.parse(init.body).content; return json({ id: "memory0001" }); }
      return json({}, 500);
    },
  });
  assert.match(memory.text, /auth-fix/);
  assert.match(memory.text, /Run the login tests/);
  await memory.afterSend();
  assert.match(saved, /Run the login tests/);

  const failed = await augmentCodexTurn({
    projectId: "project-1",
    agentId: "agent-1",
    text: "Keep going",
    runBoxId: box,
    env,
    file,
    fetchImpl: async () => { throw new Error("backboard down"); },
  });
  assert.equal(failed.text, "Keep going");
  assert.equal(failed.afterSend, undefined);

  const db = new Database(":memory:");
  const calls = [];
  let callbacks;
  const runtime = { async request(method, params) { calls.push({ method, params }); if (method === "account/read") return { account: { type: "chatgpt" } }; if (method.startsWith("thread/")) return { thread: { id: "thread-1", turns: [] } }; if (method === "turn/start") { callbacks.onNotification("turn/started", { turn: { id: "turn-1" } }); return { turn: { id: "turn-1" } }; } return {}; }, close() {}, async stop() {} };
  const service = createCodexSessionService({
    db,
    dataDir: dir,
    runtimeFactory: async (options) => { callbacks = options; return runtime; },
    projectMemory: async () => { throw new Error(`down ${key}`); },
  });
  const session = service.initialize({ projectId: "project-1", agentId: "agent-1", createdBy: "user-1" });
  await new Promise((resolve) => setImmediate(resolve));
  await service.action(session.id, { action: "message", text: "List files", requestId: randomUUID() });
  assert.equal(calls.find((call) => call.method === "turn/start").params.input[0].text, "List files");
  service.close();
  db.close();
});
