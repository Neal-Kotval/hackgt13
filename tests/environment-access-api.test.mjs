// Environment model (docs/environment-model-contract.md): names, private/public
// visibility, delete, and the access policy on every route that reaches a job.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";
import { copyRunBoxAccess } from "./run-box-access-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-environment-access-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), transpile(source).replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
const mjs = ["environment-settings", "auth", "machine-catalog", "run-box-jobs", "run-box-ssh", "ssh-keys", "agent-check", "container-templates", "aws-organization-approval",
  "aws-cpu-ssh-access", "backboard", "backboard-memory", "run-box-metadata", "run-box-access", "chat-runs"];
for (const name of mjs.filter((item) => item !== "auth"))
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
await copyRunBoxAccess(directory);
const db = fixture.getDatabase();
const store = await import(path.join(directory, "store.js"));
const metadata = await import(path.join(directory, "run-box-metadata.mjs"));
(await import(path.join(directory, "run-box-jobs.mjs"))).migrateRunBoxJobs(db);
metadata.migrateRunBoxMetadata(db);

// Execution is stubbed; sessions point at real run-box jobs so the policy is real.
await writeFile(path.join(directory, "codex-service.js"), `
import { failure } from './http.js';
import { InputError } from './store.js';
export const codexEnabled = () => true;
export const codexFailure = failure;
export const sessions = [];
export function codexService() { return {
  list: (projectId) => sessions.filter((session) => session.projectId === projectId),
  get: (id) => { const session = sessions.find((row) => row.id === id); if (!session) throw new InputError('Codex session not found.', 404); return session; },
  snapshot: (id) => ({ session: sessions.find((row) => row.id === id), events: [
    { id: 'u1', kind: 'user', text: 'Hello from ' + id, actorName: 'Someone', createdAt: '2026-09-27T01:00:00Z' },
  ] }),
  action: async () => ({ ok: true }),
  pendingPeerMessages: () => [],
  validateEnvironment: () => {},
}; }
`);
const codex = await import(path.join(directory, "codex-service.js"));

async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const code = transpile(source).replaceAll("@/lib/", "./").replaceAll(depth ? "../".repeat(depth) + "lib/" : "@/lib/", "./")
    .replace(/from ["']\.\/([\w-]+)(?:\.mjs)?["']/g, (match, name) => `from './${name}${mjs.includes(name) ? ".mjs" : ".js"}'`)
    .replace(/from ["']\.\.\/route["']/g, "from './boxes-route.js'");
  await writeFile(path.join(directory, outputName), code);
  return import(path.join(directory, outputName));
}
const boxes = await route("../app/api/run-boxes/route.ts", "boxes-route.js", 3);
const single = await route("../app/api/run-boxes/[id]/route.ts", "box-route.js", 4);
const stop = await route("../app/api/run-boxes/[id]/stop/route.ts", "stop-route.js", 5);
const forceStop = await route("../app/api/run-boxes/[id]/force-stop/route.ts", "force-stop-route.js", 5);
const memory = await route("../app/api/run-boxes/[id]/memory/route.ts", "memory-route.js", 5);
const sessionsRoute = await route("../app/api/codex-sessions/route.ts", "sessions-route.js", 0);
const sessionRoute = await route("../app/api/codex-sessions/[id]/route.ts", "session-route.js", 0);
const peerRoute = await route("../app/api/codex-sessions/[id]/peer-messages/route.ts", "peer-route.js", 0);
const chatRuns = await route("../app/api/chat-runs/route.ts", "chat-runs-route.js", 0);

const [creator, other] = fixture.users;
const project = async (name) => (await store.action({ type: "createProject", name, repo: "https://example.com/repo",
  compute: "Hosted Linux", template: "blank" })).id;
// P: creator owns, other is a member. Q: both own. R: creator only.
const P = await project("Member project");
const Q = await project("Shared owners");
const R = await project("Solo");
fixture.grantMembership(creator.id, P, "owner");
fixture.grantMembership(other.id, P, "member");
fixture.grantMembership(creator.id, Q, "owner");
fixture.grantMembership(other.id, Q, "owner");
fixture.grantMembership(creator.id, R, "owner");
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

function call(method, url, { cookie, body, origin = "http://localhost:3000" } = {}) {
  return new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const ctx = (id) => ({ params: Promise.resolve({ id }) });
let keys = 0;
// Local Docker sandboxes allow one active job per project; park earlier ones as stopped.
async function create(user, projectId, extra = {}, state = "ready") {
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE project_id = ? AND state != 'stopped'").run(projectId);
  const response = await boxes.POST(call("POST", "/api/run-boxes", { cookie: user.cookie, body: {
    projectId, profileId: "local-docker-sandbox", durationHours: 1, idempotencyKey: `env-access-${++keys}`, ...extra,
  } }));
  assert.equal(response.status, 201, await response.clone().text());
  const { job } = await response.json();
  db.prepare("UPDATE run_box_job SET state = ? WHERE id = ?").run(state, job.id);
  return job;
}
const list = async (user, projectId) => {
  const response = await boxes.GET(call("GET", `/api/run-boxes?projectId=${projectId}`, { cookie: user.cookie }));
  assert.equal(response.status, 200);
  return (await response.json()).jobs;
};
const find = async (user, projectId, id) => (await list(user, projectId)).find((job) => job.id === id);
const get = (user, projectId, id) => single.GET(call("GET", `/api/run-boxes/${id}?projectId=${projectId}`, { cookie: user.cookie }), ctx(id));
const patch = (user, id, body, options = {}) => single.PATCH(call("PATCH", `/api/run-boxes/${id}`, { cookie: user.cookie, body, ...options }), ctx(id));
const del = (user, projectId, id, options = {}) => single.DELETE(call("DELETE", `/api/run-boxes/${id}?projectId=${projectId}`, { cookie: user.cookie, ...options }), ctx(id));
const requestCount = async (projectId) => (await store.getState()).projects.find((item) => item.id === projectId).resourceRequests.length;

test("create accepts a name and visibility; new jobs default to private and unnamed", async () => {
  const plain = await create(creator, P);
  assert.equal(plain.name, null);
  assert.equal(plain.visibility, "private");
  assert.deepEqual(plain.createdBy, { id: creator.id, name: creator.email, email: creator.email });
  assert.deepEqual(plain.permissions, { open: true, stop: true, manage: true });
  const named = await create(creator, P, { name: "  Training box  ", visibility: "public" });
  assert.equal(named.name, "Training box");
  assert.equal(named.visibility, "public");
  assert.equal(metadata.getRunBoxMetadata(db, named.id).visibility, "public");

  const before = await requestCount(P);
  for (const extra of [{ name: "" }, { name: "   " }, { name: "x".repeat(61) }, { name: "tab\there" }, { name: "bell\u0007" },
    { name: 7 }, { visibility: "team" }, { visibility: null }]) {
    const response = await boxes.POST(call("POST", "/api/run-boxes", { cookie: creator.cookie, body: {
      projectId: P, profileId: "local-docker-sandbox", durationHours: 1, idempotencyKey: `invalid-${++keys}`, ...extra } }));
    assert.equal(response.status, 400, JSON.stringify(extra));
  }
  assert.equal(await requestCount(P), before, "invalid metadata is refused before any request is recorded");
  const sixty = await create(creator, P, { name: "y".repeat(60), visibility: "private" });
  assert.equal(sixty.name, "y".repeat(60));
});

test("the list shows private jobs only to their creator and public jobs to every member", async () => {
  const privateP = await create(creator, P);
  const publicP = await create(creator, P, { visibility: "public" }, "stopped");
  const privateQ = await create(creator, Q);
  const publicQ = await create(creator, Q, { visibility: "public" }, "stopped");

  assert.ok(await find(creator, P, privateP.id));
  assert.equal(await find(other, P, privateP.id), undefined, "another member");
  assert.equal(await find(other, Q, privateQ.id), undefined, "a project owner who did not create it");
  const memberView = await find(other, P, publicP.id);
  assert.deepEqual(memberView.permissions, { open: true, stop: true, manage: false });
  assert.equal(memberView.createdBy.id, creator.id);
  assert.deepEqual(Object.keys(memberView.memory).sort(), ["available", "enabled"]);
  assert.deepEqual((await find(other, Q, publicQ.id)).permissions, { open: true, stop: true, manage: true });

  // Single-job GET: the same JSON as the list entry, and the same policy.
  const detail = await get(creator, P, privateP.id);
  assert.equal(detail.status, 200);
  const { job } = await detail.json();
  assert.deepEqual(job, await find(creator, P, privateP.id));
  assert.equal((await get(other, P, privateP.id)).status, 404);
  assert.equal((await get(other, P, publicP.id)).status, 200);
  assert.equal((await get(creator, Q, privateP.id)).status, 404, "job in another project");
  assert.equal((await get(other, R, privateP.id)).status, 403, "not a project member");
  assert.equal((await get(creator, P, "missing")).status, 404);
});

test("PATCH renames and changes visibility for the creator or a project owner only", async () => {
  const job = await create(creator, P, { visibility: "public" });
  assert.equal((await patch(other, job.id, { projectId: P, name: "Mine now" })).status, 403, "member of a public job");
  assert.equal((await patch(creator, job.id, { projectId: P, name: "x" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await patch(creator, job.id, { projectId: P, name: "x", extra: 1 })).status, 400);
  assert.equal((await patch(creator, job.id, { projectId: P })).status, 400);
  for (const name of ["", "  ", "z".repeat(61), "line\nbreak", 3])
    assert.equal((await patch(creator, job.id, { projectId: P, name })).status, 400, JSON.stringify(name));
  assert.equal((await patch(creator, job.id, { projectId: P, visibility: "everyone" })).status, 400);

  const renamed = await patch(creator, job.id, { projectId: P, name: " Eval run " });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).job.name, "Eval run");
  const cleared = await (await patch(creator, job.id, { projectId: P, name: null })).json();
  assert.equal(cleared.job.name, null);
  const hidden = await (await patch(creator, job.id, { projectId: P, visibility: "private" })).json();
  assert.equal(hidden.job.visibility, "private");
  assert.equal((await patch(other, job.id, { projectId: P, name: "x" })).status, 404, "now private");

  // A project owner may manage another owner's public job.
  const shared = await create(creator, Q, { visibility: "public" });
  const byOwner = await patch(other, shared.id, { projectId: Q, name: "Owner rename" });
  assert.equal(byOwner.status, 200);
  assert.equal((await byOwner.json()).job.name, "Owner rename");
  const events = db.prepare("SELECT actor, action FROM run_box_metadata_event WHERE job_id = ? ORDER BY id").all(shared.id)
    .map((row) => ({ ...row }));
  assert.deepEqual(events, [{ actor: creator.id, action: "create" }, { actor: other.id, action: "rename" }]);
  // Making it private hides it from that owner at once.
  const privatized = await patch(other, shared.id, { projectId: Q, visibility: "private" });
  assert.equal(privatized.status, 200);
  assert.equal((await privatized.json()).job, null);
  assert.equal(await find(other, Q, shared.id), undefined);
  assert.ok(await find(creator, Q, shared.id));
});

test("DELETE requests a stop, hides the job everywhere, records the actor, and is idempotent", async () => {
  const job = await create(creator, P, { visibility: "public" });
  assert.equal((await del(other, P, job.id)).status, 403, "a member cannot delete a public job");
  assert.equal((await del(creator, P, job.id, { origin: "https://evil.example" })).status, 403);
  const deleted = await del(creator, P, job.id);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { ok: true });

  // The worker still owns termination: the job is stop-requested, not closed.
  const row = db.prepare("SELECT state, stop_requested_at, stop_requested_by FROM run_box_job WHERE id = ?").get(job.id);
  assert.equal(row.state, "ready");
  assert.ok(row.stop_requested_at);
  assert.equal(row.stop_requested_by, creator.id);
  assert.ok(db.prepare("SELECT 1 FROM run_box_transition WHERE job_id = ? AND actor = ? AND reason = 'Stop requested'").get(job.id, creator.id));
  const meta = metadata.getRunBoxMetadata(db, job.id);
  assert.ok(meta.deleted_at);
  assert.equal(meta.deleted_by, creator.id);

  for (const user of [creator, other]) assert.equal(await find(user, P, job.id), undefined);
  assert.equal((await get(creator, P, job.id)).status, 404);
  assert.equal((await patch(creator, job.id, { projectId: P, name: "x" })).status, 404);
  assert.equal((await stop.POST(call("POST", `/api/run-boxes/${job.id}/stop`, { cookie: creator.cookie, body: { projectId: P } }), ctx(job.id))).status, 404);

  const again = await del(creator, P, job.id);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true });
  assert.equal(metadata.getRunBoxMetadata(db, job.id).deleted_at, meta.deleted_at, "the first delete time is kept");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM run_box_metadata_event WHERE job_id = ? AND action = 'delete'").get(job.id).n, 1);
  assert.equal((await del(other, P, job.id)).status, 403, "idempotency does not bypass permissions");

  // A job already stopping takes the force-stop path; a never-allocated one closes at once.
  const stuck = await create(creator, P, {}, "stopping");
  db.prepare("UPDATE run_box_job SET stop_requested_at = ?, stop_requested_by = ? WHERE id = ?").run(new Date().toISOString(), creator.id, stuck.id);
  assert.equal((await del(other, P, stuck.id)).status, 404, "private to its creator");
  assert.equal((await del(creator, P, stuck.id)).status, 200);
  const forced = db.prepare("SELECT state, force_stop_requested_by FROM run_box_job WHERE id = ?").get(stuck.id);
  assert.equal(forced.force_stop_requested_by, creator.id);
  assert.equal(forced.state, "stopped");
  assert.ok(db.prepare("SELECT 1 FROM run_box_transition WHERE job_id = ? AND evidence_ref = ?").get(stuck.id, `job:never-allocated:${stuck.id}:force-stop`));

  // An allocated stopping job is not closed by delete; the worker must prove release.
  const allocated = await create(creator, P, {}, "stopping");
  db.prepare("UPDATE run_box_job SET stop_requested_at = ?, attempts = 1, provider_resource_id = 'container-1' WHERE id = ?")
    .run(new Date().toISOString(), allocated.id);
  assert.equal((await del(creator, P, allocated.id)).status, 200);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(allocated.id).state, "stopping");
  assert.equal(await find(creator, P, allocated.id), undefined);
});

test("any member can stop a public job; only the creator can stop a private one", async () => {
  const shared = await create(creator, P, { visibility: "public" });
  const stopped = await stop.POST(call("POST", `/api/run-boxes/${shared.id}/stop`, { cookie: other.cookie, body: { projectId: P } }), ctx(shared.id));
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).job.stop_requested_by, other.id);
  const mine = await create(creator, P);
  assert.equal((await stop.POST(call("POST", `/api/run-boxes/${mine.id}/stop`, { cookie: other.cookie, body: { projectId: P } }), ctx(mine.id))).status, 404);
  assert.equal((await forceStop.POST(call("POST", `/api/run-boxes/${mine.id}/force-stop`, { cookie: other.cookie, body: { projectId: P } }), ctx(mine.id))).status, 404);
  assert.equal((await stop.POST(call("POST", `/api/run-boxes/${mine.id}/stop`, { cookie: creator.cookie, body: { projectId: P } }), ctx(mine.id))).status, 200);
});

test("a legacy job without a metadata row behaves as public", async () => {
  const legacy = await create(creator, P);
  db.prepare("DELETE FROM run_box_metadata_event WHERE job_id = ?").run(legacy.id);
  db.prepare("DELETE FROM run_box_metadata WHERE job_id = ?").run(legacy.id);
  const seen = await find(other, P, legacy.id);
  assert.equal(seen.visibility, "public");
  assert.equal(seen.name, null);
  assert.deepEqual(seen.permissions, { open: true, stop: true, manage: false });
  assert.equal((await get(other, P, legacy.id)).status, 200);
  // Renaming keeps it public; the creator can still make it private.
  const renamed = await (await patch(creator, legacy.id, { projectId: P, name: "Old box" })).json();
  assert.equal(renamed.job.visibility, "public");
  const stopped = await stop.POST(call("POST", `/api/run-boxes/${legacy.id}/stop`, { cookie: other.cookie, body: { projectId: P } }), ctx(legacy.id));
  assert.equal(stopped.status, 200);
});

test("shared memory: private is 404 to others, and switching needs manage permission", async () => {
  const shared = await create(creator, P, { visibility: "public" });
  const hidden = await create(creator, Q);
  const toggle = (user, projectId, id) => memory.POST(call("POST", `/api/run-boxes/${id}/memory`, { cookie: user.cookie,
    body: { projectId, enabled: true } }), ctx(id));
  assert.equal((await toggle(other, P, shared.id)).status, 403, "member of a public job");
  assert.equal((await toggle(other, Q, hidden.id)).status, 404, "another owner's private job");
  const enabled = await toggle(creator, P, shared.id);
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).memory.enabled, true);
  assert.equal((await find(other, P, shared.id)).memory.enabled, true);
});

test("Codex sessions and chat runs on a private environment are hidden from other members", async () => {
  const mine = await create(creator, P);
  const shared = await create(creator, P, { visibility: "public" }, "stopped");
  codex.sessions.push(
    { id: "private-session", projectId: P, agentId: "a1", status: "ready", isSetupSession: false, target: { kind: "runBox", runBoxId: mine.id } },
    { id: "public-session", projectId: P, agentId: "a2", status: "ready", isSetupSession: false, target: { kind: "runBox", runBoxId: shared.id } },
  );
  const listed = async (user) => (await (await sessionsRoute.GET(call("GET", `/api/codex-sessions?projectId=${P}`, { cookie: user.cookie }))).json())
    .sessions.map((session) => session.id).sort();
  assert.deepEqual(await listed(creator), ["private-session", "public-session"]);
  assert.deepEqual(await listed(other), ["public-session"]);

  const read = (user, id) => sessionRoute.GET(call("GET", `/api/codex-sessions/${id}`, { cookie: user.cookie }), ctx(id));
  const send = (user, id) => sessionRoute.POST(call("POST", `/api/codex-sessions/${id}`, { cookie: user.cookie,
    body: { action: "message", text: "hi" } }), ctx(id));
  assert.equal((await read(other, "private-session")).status, 404);
  assert.equal((await send(other, "private-session")).status, 404);
  assert.equal((await peerRoute.GET(call("GET", "/api/codex-sessions/private-session/peer-messages", { cookie: other.cookie }), ctx("private-session"))).status, 404);
  assert.equal((await read(other, "public-session")).status, 200);
  assert.equal((await send(other, "public-session")).status, 200);
  assert.equal((await read(creator, "private-session")).status, 200);
  assert.equal((await send(creator, "private-session")).status, 200);
  const newChat = (user, runBoxId) => sessionsRoute.POST(call("POST", "/api/codex-sessions", { cookie: user.cookie,
    body: { projectId: P, runBoxId, newChat: true, requestId: "8f1f9a4e-5b0c-4c55-9d7a-2f0f3c1e6b11" } }));
  assert.equal((await newChat(other, mine.id)).status, 404);

  const runs = async (user) => (await (await chatRuns.GET(call("GET", `/api/chat-runs?projectId=${P}`, { cookie: user.cookie }))).json())
    .runs.map((run) => run.sessionId).sort();
  assert.deepEqual(await runs(creator), ["private-session", "public-session"]);
  assert.deepEqual(await runs(other), ["public-session"]);

  // Deleting an environment hides its sessions and runs from everyone.
  assert.equal((await del(creator, P, mine.id)).status, 200);
  assert.deepEqual(await listed(creator), ["public-session"]);
  assert.deepEqual(await runs(creator), ["public-session"]);
  assert.equal((await read(creator, "private-session")).status, 404);
});
