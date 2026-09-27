import { test, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-project-memory-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
delete process.env.BACKBOARD_API_KEY;
delete process.env.BACKBOARD_API_BASE;
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), transpile(source).replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
for (const name of ["run-box-jobs", "aws-organization-approval", "backboard", "backboard-memory"])
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const routeSource = await readFile(new URL("../app/api/projects/[id]/memory/route.ts", import.meta.url), "utf8");
await writeFile(path.join(directory, "memory-route.js"), transpile(routeSource)
  .replace(/from ["'](?:\.\.\/)+lib\/([\w-]+)\.mjs["']/g, "from './$1.mjs'")
  .replace(/from ["'](?:\.\.\/)+lib\/([\w-]+)["']/g, "from './$1.js'"));
const route = await import(path.join(directory, "memory-route.js"));
const store = await import(path.join(directory, "store.js"));
const memory = await import(path.join(directory, "backboard-memory.mjs"));
const realFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = realFetch;
  fixture.getDatabase().close();
  await rm(directory, { recursive: true, force: true });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BACKBOARD_API_KEY;
});

const [owner, outsider] = fixture.users;
const KEY = "bb-test-key-do-not-leak-0123456789";
const created = await store.action({ type: "createProject", name: "Memory test", repo: "https://example.com/team/repo", template: "blank", compute: "Hosted Linux" });
const projectId = created.id;
fixture.grantMembership(owner.id, projectId, "owner");
const get = (cookie, q) => route.GET(
  new Request(`http://localhost:3000/api/projects/${projectId}/memory${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`, { headers: cookie ? { cookie } : {} }),
  { params: Promise.resolve({ id: projectId }) },
);
function mockBackboard(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", key: new Headers(init.headers).get("x-api-key"), body: init.body });
    return new Response(JSON.stringify(handler(String(url), init)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return calls;
}

test("only project members can read project memory", async () => {
  process.env.BACKBOARD_API_KEY = KEY;
  const calls = mockBackboard(() => ({ memories: [] }));
  assert.equal((await get(null)).status, 401);
  assert.equal((await get(outsider.cookie)).status, 403);
  assert.equal(calls.length, 0);
});

test("reports unavailable without a key and never contacts Backboard", async () => {
  const calls = mockBackboard(() => ({}));
  const response = await get(owner.cookie);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { available: false });
  assert.equal(calls.length, 0);
});

test("a project without an assistant returns an empty list and does not create one", async () => {
  process.env.BACKBOARD_API_KEY = KEY;
  const calls = mockBackboard(() => ({ assistant_id: "assistant-should-not-exist" }));
  const data = await (await get(owner.cookie)).json();
  assert.deepEqual(data, { available: true, created: false, query: "", memories: [] });
  assert.equal(calls.length, 0);
  const db = memory.openBackboardDb(memory.defaultBackboardFile());
  try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM backboard_project").get().n, 0); } finally { db.close(); }
});

test("lists and searches saved facts through the project's assistant without returning the key", async () => {
  process.env.BACKBOARD_API_KEY = KEY;
  const db = memory.openBackboardDb(memory.defaultBackboardFile());
  db.prepare("INSERT INTO backboard_project (project_id, assistant_id, created_at) VALUES (?, ?, ?)").run(projectId, "assistant0001", new Date().toISOString());
  db.close();
  const calls = mockBackboard((url) => url.endsWith("/memories/search")
    ? { memories: [{ id: "memory0002", content: "Login route is on auth-fix", score: 0.91 }] }
    : { memories: [{ id: "memory0001", content: "Deploys run from main", created_at: "2026-09-27T00:00:00Z" }, { content: "" }] });
  const listed = await get(owner.cookie);
  const listedText = await listed.text();
  assert.equal(listed.status, 200);
  assert.ok(!listedText.includes(KEY));
  assert.deepEqual(JSON.parse(listedText).memories, [{ id: "memory0001", content: "Deploys run from main", createdAt: "2026-09-27T00:00:00Z", score: null }]);
  assert.match(calls[0].url, /\/assistants\/assistant0001\/memories$/);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].key, KEY);
  const searched = await (await get(owner.cookie, "  login ")).json();
  assert.equal(searched.query, "login");
  assert.deepEqual(searched.memories.map((item) => item.content), ["Login route is on auth-fix"]);
  assert.match(calls[1].url, /\/assistants\/assistant0001\/memories\/search$/);
  assert.equal(JSON.parse(calls[1].body).query, "login");
  assert.equal((await get(owner.cookie, "x".repeat(501))).status, 400);
});

test("a Backboard failure is reported without details", async () => {
  process.env.BACKBOARD_API_KEY = KEY;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status: 401 });
  const response = await get(owner.cookie);
  assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes(KEY));
});
