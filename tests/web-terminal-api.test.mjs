import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";
import { ed25519PublicKey } from "./ssh-key-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-web-terminal-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const mjs = ["auth", "run-box-jobs", "ssh-keys", "run-box-ssh", "agent-check", "aws-organization-approval", "codex-runner-key", "web-terminal", "run-box-access", "run-box-metadata", "machine-catalog"];
const relink = (code) => code.replace(/from ["']\.\/([\w-]+)(?:\.mjs)?["']/g, (match, name) => `from './${name}${mjs.includes(name) ? ".mjs" : ".js"}'`);
for (const name of ["store", "http", "resource-profiles", "web-terminal-service"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), relink(transpile(source)));
}
for (const name of mjs.filter((item) => item !== "auth"))
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
const store = await import(path.join(directory, "store.js"));
const jobs = await import(path.join(directory, "run-box-jobs.mjs"));
const endpoints = await import(path.join(directory, "run-box-ssh.mjs"));
const sshKeys = await import(path.join(directory, "ssh-keys.mjs"));
const bridge = await import(path.join(directory, "web-terminal.mjs"));
const metadata = await import(path.join(directory, "run-box-metadata.mjs"));
async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  await writeFile(path.join(directory, outputName), relink(transpile(source).replaceAll("../".repeat(depth) + "lib/", "./")));
  return import(path.join(directory, outputName));
}
const openRoute = await route("../app/api/run-boxes/[id]/terminal/route.ts", "terminal-route.js", 5);
const sessionRoute = await route("../app/api/run-boxes/[id]/terminal/[sessionId]/route.ts", "terminal-session-route.js", 6);
const inputRoute = await route("../app/api/run-boxes/[id]/terminal/[sessionId]/input/route.ts", "terminal-input-route.js", 7);
const resizeRoute = await route("../app/api/run-boxes/[id]/terminal/[sessionId]/resize/route.ts", "terminal-resize-route.js", 7);
const streamRoute = await route("../app/api/run-boxes/[id]/terminal/[sessionId]/stream/route.ts", "terminal-stream-route.js", 7);
const [owner, member] = fixture.users;

// Inject the bridge with a fake SSH spawner through the route module's shared singleton.
const shells = [];
const runnerPublic = ed25519PublicKey();
const runner = { keyFile: path.join(directory, "runner-key"), fingerprint: sshKeys.sshFingerprint(runnerPublic) };
await writeFile(runner.keyFile, "fake private key");
globalThis.agentcloudWebTerminal = bridge.createWebTerminalService({
  db, getRunnerKey: async () => runner, sweepMs: 0,
  openShell: async (options, handlers) => {
    const shell = { options, handlers, writes: [], sizes: [], closed: false };
    shells.push(shell);
    return { write: (data) => shell.writes.push(data), resize: (c, r) => shell.sizes.push([c, r]), close: () => { shell.closed = true; } };
  },
});
after(async () => { globalThis.agentcloudWebTerminal.dispose(); db.close(); await rm(directory, { recursive: true, force: true }); });

function call(url, { method = "GET", body, cookie, origin = "http://localhost:3000", headers = {} } = {}) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (id, sessionId) => ({ params: Promise.resolve(sessionId ? { id, sessionId } : { id }) });

async function readyJob(projectId, key) {
  jobs.migrateRunBoxJobs(db);
  endpoints.migrateRunBoxSsh(db);
  const { job } = jobs.saveRunBoxDecision(db, {
    idempotencyKey: key, resourceRequestId: `request-${key}`, projectId, employeeId: owner.id,
    organizationId: fixture.organization.id, projectRole: "owner", provider: "docker-local",
    profileId: "local-docker-sandbox", maxDurationMinutes: 60, repoUrl: null,
  });
  return job;
}
const makeReady = (job) => {
  db.prepare("UPDATE run_box_job SET state = 'ready' WHERE id = ?").run(job.id);
  endpoints.recordRunBoxSshEndpoint(db, job.id, { host: "127.0.0.1", port: 2222, username: "agentcloud",
    hostPublicKey: ed25519PublicKey(), authorizedFingerprints: [], serverFingerprint: runner.fingerprint });
};

test("terminal open route: 401, 403, 404, 409, and cross-origin checks", async () => {
  const projectId = (await store.action({ type: "createProject", name: "Terminal", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, projectId, "owner");
  const otherProject = (await store.action({ type: "createProject", name: "Other", repo: "https://example.com/other", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, otherProject, "owner");
  const job = await readyJob(projectId, "terminal-1");
  const open = (cookie, { id = job.id, project = projectId, origin } = {}) =>
    openRoute.POST(call(`/api/run-boxes/${id}/terminal`, { method: "POST", cookie, origin, body: { projectId: project, cols: 80, rows: 24 } }), params(id));

  assert.equal((await open(null)).status, 401);
  assert.equal((await open(member.cookie)).status, 403); // org member, not a project member
  assert.equal((await open(owner.cookie, { id: "00000000-0000-0000-0000-000000000000" })).status, 404);
  assert.equal((await open(owner.cookie, { project: otherProject })).status, 404); // job belongs to another project
  assert.equal((await open(owner.cookie, { origin: "https://evil.example" })).status, 403);
  const queued = await open(owner.cookie);
  assert.equal(queued.status, 409);
  assert.equal((await queued.json()).code, "not_ready");
  assert.equal(shells.length, 0);

  makeReady(job);
  const opened = await open(owner.cookie);
  assert.equal(opened.status, 201);
  const { sessionId } = await opened.json();
  assert.match(sessionId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(bridge.listTerminalEvents(db, job.id).at(-1).employee_id, owner.id);
  await sessionRoute.DELETE(call(`/api/run-boxes/${job.id}/terminal/${sessionId}`, { method: "DELETE", cookie: owner.cookie }), params(job.id, sessionId));
});

test("session routes: another employee's session is a 404; its opener can stream, type, resize, and close", async () => {
  const projectId = (await store.action({ type: "createProject", name: "Shared", repo: "https://example.com/shared", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, projectId, "owner");
  fixture.grantMembership(member.id, projectId, "member");
  const job = await readyJob(projectId, "terminal-2");
  makeReady(job);
  const opened = await openRoute.POST(call(`/api/run-boxes/${job.id}/terminal`, { method: "POST", cookie: member.cookie, body: { projectId, cols: 100, rows: 30 } }), params(job.id));
  assert.equal(opened.status, 201);
  const { sessionId } = await opened.json();
  const shell = shells.at(-1);
  const input = (cookie, data, { origin, id = job.id } = {}) =>
    inputRoute.POST(call(`/api/run-boxes/${id}/terminal/${sessionId}/input`, { method: "POST", cookie, origin, body: { data } }), params(id, sessionId));
  const stream = (cookie, headers = {}) =>
    streamRoute.GET(call(`/api/run-boxes/${job.id}/terminal/${sessionId}/stream`, { cookie, origin: null, headers }), params(job.id, sessionId));

  // A project member opened this session. Even the organization owner cannot use it.
  assert.equal((await input(owner.cookie, "id\r")).status, 404);
  assert.equal((await stream(owner.cookie)).status, 404);
  assert.equal((await resizeRoute.POST(call(`/api/run-boxes/${job.id}/terminal/${sessionId}/resize`, { method: "POST", cookie: owner.cookie, body: { cols: 90, rows: 20 } }), params(job.id, sessionId))).status, 404);
  assert.equal((await sessionRoute.DELETE(call(`/api/run-boxes/${job.id}/terminal/${sessionId}`, { method: "DELETE", cookie: owner.cookie }), params(job.id, sessionId))).status, 404);
  assert.equal((await input(null, "id\r")).status, 401);
  assert.equal((await input(member.cookie, "id\r", { origin: "https://evil.example" })).status, 403);
  assert.equal((await input(member.cookie, "id\r", { id: "00000000-0000-0000-0000-000000000000" })).status, 404);
  assert.equal((await stream(member.cookie, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.deepEqual(shell.writes, []);
  assert.equal(shell.closed, false);

  const response = await stream(member.cookie);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const readUntil = async (pattern) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  shell.handlers.onData(Buffer.from("hello from box\r\n"));
  await readUntil(/data: /);
  assert.match(text, new RegExp(`data: ${Buffer.from("hello from box\r\n").toString("base64")}`));
  assert.equal((await stream(member.cookie)).status, 200); // Second attach is refused inside the stream.
  assert.equal((await input(member.cookie, "echo hello && pwd\r")).status, 204);
  assert.deepEqual(shell.writes, ["echo hello && pwd\r"]);
  assert.equal((await resizeRoute.POST(call(`/api/run-boxes/${job.id}/terminal/${sessionId}/resize`, { method: "POST", cookie: member.cookie, body: { cols: 90, rows: 20 } }), params(job.id, sessionId))).status, 204);
  assert.deepEqual(shell.sizes, [[90, 20]]);

  // Losing project membership ends the session on its next request.
  db.prepare("DELETE FROM project_membership WHERE user_id = ? AND project_id = ?").run(member.id, projectId);
  assert.equal((await input(member.cookie, "ls\r")).status, 403);
  assert.equal(shell.closed, true);
  await readUntil(/event: close/);
  assert.match(text, /"reason":"access_revoked"/);
  assert.equal(bridge.listTerminalEvents(db, job.id).at(-1).reason, "access_revoked");
});

test("a private environment's terminal is a 404 for everyone but its creator", async () => {
  const projectId = (await store.action({ type: "createProject", name: "Private", repo: "https://example.com/private", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, projectId, "owner");
  fixture.grantMembership(member.id, projectId, "member");
  const job = await readyJob(projectId, "terminal-3");
  metadata.createRunBoxMetadata(db, job.id, owner.id, { visibility: "private" });
  makeReady(job);
  const open = (cookie) => openRoute.POST(call(`/api/run-boxes/${job.id}/terminal`, { method: "POST", cookie, body: { projectId, cols: 80, rows: 24 } }), params(job.id));
  const denied = await open(member.cookie);
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).error, "Run-box job not found");
  const opened = await open(owner.cookie);
  assert.equal(opened.status, 201);
  const { sessionId } = await opened.json();
  // Turning a public job private ends another member's open session on their next request.
  metadata.updateRunBoxMetadata(db, job.id, owner.id, { visibility: "public" });
  const memberOpened = await open(member.cookie);
  assert.equal(memberOpened.status, 201);
  const memberSession = (await memberOpened.json()).sessionId;
  metadata.updateRunBoxMetadata(db, job.id, owner.id, { visibility: "private" });
  const typed = await inputRoute.POST(call(`/api/run-boxes/${job.id}/terminal/${memberSession}/input`, { method: "POST", cookie: member.cookie, body: { data: "ls\r" } }), params(job.id, memberSession));
  assert.equal(typed.status, 404);
  assert.equal(shells.at(-1).closed, true);
  assert.equal(bridge.listTerminalEvents(db, job.id).at(-1).reason, "access_revoked");
  await sessionRoute.DELETE(call(`/api/run-boxes/${job.id}/terminal/${sessionId}`, { method: "DELETE", cookie: owner.cookie }), params(job.id, sessionId));
});
