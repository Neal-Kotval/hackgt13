import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-agent-runs-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), transpile(source).replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
const mjs = ["auth", "run-box-jobs", "agent-runs"];
for (const name of ["run-box-jobs", "agent-runs"])
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
const store = await import(path.join(directory, "store.js"));
const jobs = await import(path.join(directory, "run-box-jobs.mjs"));
const runsLib = await import(path.join(directory, "agent-runs.mjs"));
async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const code = transpile(source).replaceAll("../".repeat(depth) + "lib/", "./")
    .replace(/from ["']\.\/([\w-]+)(?:\.mjs)?["']/g, (match, name) => `from './${name}${mjs.includes(name) ? ".mjs" : ".js"}'`);
  await writeFile(path.join(directory, outputName), code);
  return import(path.join(directory, outputName));
}
const runsRoute = await route("../app/api/agent-runs/route.ts", "runs-route.js", 3);
const runRoute = await route("../app/api/agent-runs/[id]/route.ts", "run-route.js", 4);
const eventsRoute = await route("../app/api/agent-runs/[id]/events/route.ts", "events-route.js", 5);
const finishRoute = await route("../app/api/agent-runs/[id]/finish/route.ts", "finish-route.js", 5);
const [owner, member] = fixture.users;
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

function call(url, { method = "GET", body, cookie, origin = "http://localhost:3000" } = {}) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}
const params = (id) => ({ params: Promise.resolve({ id }) });
const create = (cookie, body, extra = {}) =>
  runsRoute.POST(call("/api/agent-runs", { method: "POST", body, cookie, ...extra }));
const append = (cookie, id, events, extra = {}) =>
  eventsRoute.POST(call(`/api/agent-runs/${id}/events`, { method: "POST", body: { events }, cookie, ...extra }), params(id));
const finish = (cookie, id, body, extra = {}) =>
  finishRoute.POST(call(`/api/agent-runs/${id}/finish`, { method: "POST", body, cookie, ...extra }), params(id));
const get = (cookie, id, query = "") => runRoute.GET(call(`/api/agent-runs/${id}${query}`, { cookie }), params(id));
const list = (cookie, projectId) => runsRoute.GET(call(`/api/agent-runs?projectId=${projectId}`, { cookie }));
const event = (seq, extra = {}) => ({ seq, kind: "message", actor: "codex", text: `event ${seq}`, at: new Date(Date.UTC(2026, 8, 26, 12, 0, seq)).toISOString(), ...extra });

let projectId;
let otherProjectId;
let readyBox;
let queuedBox;
let key = 0;
function box(project, employeeId, state) {
  const { job } = jobs.saveRunBoxDecision(db, {
    idempotencyKey: `agent-runs-${++key}`, resourceRequestId: `request-agent-runs-${key}`, projectId: project,
    employeeId, organizationId: fixture.organization.id, projectRole: "owner",
    provider: "docker-local", profileId: "local-docker-sandbox", maxDurationMinutes: 60, repoUrl: "https://example.com/repo",
  });
  if (state !== "queued") db.prepare("UPDATE run_box_job SET state = ? WHERE id = ?").run(state, job.id);
  return job;
}

before(async () => {
  projectId = (await store.action({ type: "createProject", name: "Runs test", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
  otherProjectId = (await store.action({ type: "createProject", name: "Other", repo: "https://example.com/other", compute: "Hosted Linux", template: "blank" })).id;
  fixture.grantMembership(owner.id, projectId, "owner");
  fixture.grantMembership(owner.id, otherProjectId, "owner");
  jobs.migrateRunBoxJobs(db);
  readyBox = box(projectId, owner.id, "ready");
  queuedBox = box(otherProjectId, owner.id, "queued");
});

test("create: auth, membership, readiness, and input bounds", async () => {
  const input = { runBoxId: readyBox.id, agent: "codex", prompt: "Fix the failing test" };
  assert.equal((await create(null, input)).status, 401);
  assert.equal((await create(member.cookie, input)).status, 403); // org member, not a project member
  assert.equal((await create(owner.cookie, input, { origin: "https://evil.example" })).status, 403);
  assert.equal((await create(owner.cookie, { ...input, runBoxId: "missing" })).status, 404);
  assert.equal((await create(owner.cookie, { ...input, runBoxId: queuedBox.id })).status, 409);
  assert.equal((await create(owner.cookie, { ...input, agent: "claude" })).status, 400);
  assert.equal((await create(owner.cookie, { ...input, prompt: "" })).status, 400);
  assert.equal((await create(owner.cookie, { ...input, prompt: "x".repeat(4001) })).status, 400);
  assert.equal((await create(owner.cookie, { ...input, projectId: otherProjectId })).status, 400);
  assert.equal((await list(owner.cookie, projectId).then((r) => r.json())).runs.length, 0);

  // Desktop main-process requests omit Origin; the session cookie still authenticates them.
  const created = await create(owner.cookie, { ...input, prompt: "x".repeat(4000) }, { origin: null });
  assert.equal(created.status, 201);
  const { run } = await created.json();
  assert.equal(run.projectId, projectId);
  assert.equal(run.runBoxId, readyBox.id);
  assert.equal(run.employeeId, owner.id);
  assert.equal(run.employeeName, owner.name);
  assert.equal(run.status, "running");
  assert.equal(run.finishedAt, null);
  assert.equal(run.exitCode, null);
  assert.deepEqual(run.environment, { provider: "docker-local", profileId: "local-docker-sandbox", state: "ready" });
});

test("events: idempotent by seq, owner-only, bounded, and ordered on read", async () => {
  const { run } = await (await create(owner.cookie, { runBoxId: readyBox.id, agent: "codex", prompt: "Run tests" })).json();
  assert.equal((await append(null, run.id, [event(0)])).status, 401);
  assert.equal((await append(member.cookie, run.id, [event(0)])).status, 403);
  assert.equal((await append(owner.cookie, run.id, [event(0)], { origin: "https://evil.example" })).status, 403);
  assert.equal((await append(owner.cookie, "missing", [event(0)])).status, 404);

  // Another project member who did not start the run may read but not append or finish.
  fixture.grantMembership(member.id, projectId, "member");
  const denied = await append(member.cookie, run.id, [event(0)]);
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /employee who started/);
  assert.equal((await finish(member.cookie, run.id, { status: "failed" })).status, 403);
  assert.equal((await get(member.cookie, run.id)).status, 200);

  const first = await append(owner.cookie, run.id, [event(2), event(0), event(1, { kind: "command.start", command: "npm test" })], { origin: null });
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { accepted: 3, duplicates: 0 });
  // Retrying a batch never overwrites: seq 1 keeps its first report.
  const retry = await append(owner.cookie, run.id, [event(1, { text: "changed" }), event(3, { kind: "command.exit", exitCode: 1, command: "npm test" }), event(3)]);
  assert.deepEqual(await retry.json(), { accepted: 1, duplicates: 2 });

  // Bounds: text and command are truncated with a marker; invalid shapes are rejected.
  const long = "a".repeat(20000);
  assert.deepEqual(await (await append(owner.cookie, run.id, [event(4, { kind: "command.output", text: long, command: long })])).json(), { accepted: 1, duplicates: 0 });
  assert.equal((await append(owner.cookie, run.id, [])).status, 400);
  assert.equal((await append(owner.cookie, run.id, Array.from({ length: 201 }, (_, i) => event(100 + i)))).status, 413);
  assert.equal((await append(owner.cookie, run.id, [event(5, { kind: "shell" })])).status, 400);
  assert.equal((await append(owner.cookie, run.id, [event(5, { actor: "root" })])).status, 400);
  assert.equal((await append(owner.cookie, run.id, [event(-1)])).status, 400);
  assert.equal((await append(owner.cookie, run.id, [event(1.5)])).status, 400);
  assert.equal((await append(owner.cookie, run.id, [event(5, { at: "yesterday" })])).status, 400);
  assert.equal((await append(owner.cookie, run.id, [event(5, { exitCode: "1" })])).status, 400);
  assert.equal((await append(owner.cookie, run.id, [event(5, { token: "secret" })])).status, 400);
  // A rejected batch records nothing, including its valid events.
  assert.equal((await append(owner.cookie, run.id, [event(5), event(6, { kind: "shell" })])).status, 400);
  const batch = Array.from({ length: 200 }, (_, i) => event(1000 + i, { text: "o".repeat(8192) }));
  assert.deepEqual(await (await append(owner.cookie, run.id, batch)).json(), { accepted: 200, duplicates: 0 });

  const detail = await (await get(owner.cookie, run.id)).json();
  assert.deepEqual(detail.events.slice(0, 5).map((item) => item.seq), [0, 1, 2, 3, 4]);
  assert.equal(detail.events.length, 205);
  assert.equal(detail.hasMore, false);
  assert.equal(detail.run.eventCount, 205);
  assert.equal(detail.events[1].text, "event 1");
  assert.equal(detail.events[1].command, "npm test");
  assert.equal(detail.events[3].exitCode, 1);
  const truncated = detail.events[4];
  assert.equal(truncated.text.length, 8192);
  assert.equal(truncated.command.length, 8192);
  assert.ok(truncated.text.endsWith(runsLib.TRUNCATION_MARKER));
  assert.equal(detail.events[5].text.length, 8192);
  assert.ok(!detail.events[5].text.endsWith(runsLib.TRUNCATION_MARKER));
  const newer = await (await get(owner.cookie, run.id, "?afterSeq=3")).json();
  assert.deepEqual(newer.events.slice(0, 2).map((item) => item.seq), [4, 1000]);
  assert.equal((await get(owner.cookie, run.id, "?afterSeq=abc")).status, 400);
});

test("finish: owner-only terminal status, idempotent retry, conflict on change", async () => {
  const { run } = await (await create(owner.cookie, { runBoxId: readyBox.id, agent: "codex", prompt: "Finish me" })).json();
  assert.equal((await finish(null, run.id, { status: "succeeded" })).status, 401);
  assert.equal((await finish(owner.cookie, run.id, { status: "running" })).status, 400);
  assert.equal((await finish(owner.cookie, run.id, { status: "succeeded", exitCode: 0.5 })).status, 400);
  assert.equal((await finish(owner.cookie, run.id, { status: "succeeded" }, { origin: "https://evil.example" })).status, 403);
  const done = await finish(owner.cookie, run.id, { status: "failed", exitCode: 2 }, { origin: null });
  assert.equal(done.status, 200);
  const finished = (await done.json()).run;
  assert.equal(finished.status, "failed");
  assert.equal(finished.exitCode, 2);
  assert.ok(finished.finishedAt);
  assert.equal((await finish(owner.cookie, run.id, { status: "failed", exitCode: 2 })).status, 200);
  assert.equal((await finish(owner.cookie, run.id, { status: "succeeded", exitCode: 0 })).status, 409);
});

test("list and get: membership, newest first, no events in list", async () => {
  const outsider = await list(member.cookie, otherProjectId);
  assert.equal(outsider.status, 403);
  assert.equal((await list(null, projectId)).status, 401);
  const { runs } = await (await list(owner.cookie, projectId)).json();
  assert.ok(runs.length >= 3);
  const started = runs.map((run) => run.startedAt);
  assert.deepEqual(started, [...started].sort().reverse());
  assert.equal(runs[0].prompt, "Finish me");
  assert.equal("events" in runs[0], false);
  // Member of the project sees the same list.
  assert.equal((await (await list(member.cookie, projectId)).json()).runs.length, runs.length);

  // A run in a project the caller cannot access is hidden behind 403.
  db.prepare("UPDATE run_box_job SET state = 'ready' WHERE id = ?").run(queuedBox.id);
  const other = await (await create(owner.cookie, { runBoxId: queuedBox.id, agent: "codex", prompt: "Other" })).json();
  assert.equal((await get(member.cookie, other.run.id)).status, 403);
  assert.equal((await get(null, other.run.id)).status, 401);
  assert.equal((await get(owner.cookie, "missing")).status, 404);
  const { runs: otherRuns } = await (await list(owner.cookie, otherProjectId)).json();
  assert.deepEqual(otherRuns.map((run) => run.id), [other.run.id]);
});
