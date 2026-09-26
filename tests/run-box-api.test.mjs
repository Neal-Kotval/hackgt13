import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-run-box-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
await copyFile(new URL("../lib/run-box-jobs.mjs", import.meta.url), path.join(directory, "run-box-jobs.mjs"));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
const store = await import(path.join(directory, "store.js"));
async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const prefix = "../".repeat(depth) + "lib/";
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replaceAll(prefix, "./").replace(/from ["']\.\/([\w-]+)["']/g, (match, name) =>
    `from './${name}${["auth", "run-box-jobs"].includes(name) ? ".mjs" : ".js"}'`);
  await writeFile(path.join(directory, outputName), code);
  return import(path.join(directory, outputName));
}
const boxes = await route("../app/api/run-boxes/route.ts", "boxes-route.js", 3);
const stop = await route("../app/api/run-boxes/[id]/stop/route.ts", "stop-route.js", 5);
const owner = fixture.users[0];
const member = fixture.users[1];
const projectId = (await store.action({ type: "createProject", name: "GPU test", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
fixture.grantMembership(owner.id, projectId, "owner");
fixture.grantMembership(member.id, projectId, "member");
const actor = (user, role) => ({ employeeId: user.id, organizationId: fixture.organization.id, projectRole: role });
async function gpuRequest(user, role) {
  return (await store.resourceAction({ type: "requestResource", projectId, kind: "gpu", purpose: "GPU smoke", gpuProfileId: "g6-l4-small", durationHours: 1 }, actor(user, role))).request;
}
function request(url, body, cookie) {
  return new Request(`http://localhost:3000${url}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

test("approval API binds a saved request to verified owner and rejects cross-project or duplicate decisions", async () => {
  const saved = await gpuRequest(owner, "owner");
  const input = { projectId, resourceRequestId: saved.id, idempotencyKey: "approval-test-1", repoUrl: "https://attacker.example/other.git" };
  assert.equal((await boxes.POST(request("/api/run-boxes", input))).status, 401);
  assert.equal((await boxes.POST(request("/api/run-boxes", input, member.cookie))).status, 403);
  const approved = await boxes.POST(request("/api/run-boxes", input, owner.cookie));
  assert.equal(approved.status, 201);
  const { decision, job } = await approved.json();
  assert.equal(decision.outcome, "approved");
  assert.equal(job.state, "queued");
  assert.equal(job.max_duration_minutes, 60);
  assert.equal(job.repo_url, "https://example.com/repo");
  assert.equal(job.repo_revision, null);
  const retry = await boxes.POST(request("/api/run-boxes", input, owner.cookie));
  assert.equal((await retry.json()).job.id, job.id);
  assert.equal((await boxes.POST(request("/api/run-boxes", { ...input, idempotencyKey: "different-key" }, owner.cookie))).status, 409);
  const nextRequest = await gpuRequest(owner, "owner");
  assert.equal((await boxes.POST(request("/api/run-boxes", { projectId, resourceRequestId: nextRequest.id, idempotencyKey: "approval-test-2" }, owner.cookie))).status, 409);
  assert.equal((await boxes.GET(request(`/api/run-boxes?projectId=wrong-project`, null, owner.cookie))).status, 403);
  assert.equal((await boxes.GET(request(`/api/run-boxes?projectId=${projectId}`, null, member.cookie))).status, 200);
  assert.equal((await (await boxes.GET(request(`/api/run-boxes?projectId=${projectId}`, null, member.cookie))).json()).jobs[0].id, job.id);
});

test("member decision denies allocation and stop is owner-scoped and durable", async () => {
  const saved = await gpuRequest(member, "member");
  const input = { projectId, resourceRequestId: saved.id, idempotencyKey: "member-test-1" };
  const denied = await boxes.POST(request("/api/run-boxes", input, member.cookie));
  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).job, null);
  const job = db.prepare("SELECT * FROM run_box_job LIMIT 1").get();
  assert.equal((await stop.POST(request(`/api/run-boxes/${job.id}/stop`, { projectId }, member.cookie), { params: Promise.resolve({ id: job.id }) })).status, 403);
  const stopped = await stop.POST(request(`/api/run-boxes/${job.id}/stop`, { projectId }, owner.cookie), { params: Promise.resolve({ id: job.id }) });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).job.state, "stopping");
  assert.ok(db.prepare("SELECT stop_requested_at FROM run_box_job WHERE id = ?").get(job.id).stop_requested_at);
});

// One-step environment path: { projectId, profileId, durationHours, idempotencyKey }.
const requestCount = async () => (await store.getState()).projects.find((item) => item.id === projectId).resourceRequests.length;
const environment = (overrides = {}) => ({ projectId, profileId: "runpod-rtx-4090", durationHours: 2, idempotencyKey: "env-runpod-1", ...overrides });

test("one-step environment path validates the body before recording anything", async () => {
  const before = await requestCount();
  assert.equal((await boxes.POST(request("/api/run-boxes", environment()))).status, 401);
  for (const input of [
    environment({ profileId: "attacker-profile" }),
    environment({ profileId: "__proto__" }),
    environment({ durationHours: 3 }),
    environment({ durationHours: "1" }),
    environment({ idempotencyKey: "" }),
    environment({ idempotencyKey: "k".repeat(129) }),
    environment({ repoUrl: "https://attacker.example/other.git" }),
  ]) {
    const response = await boxes.POST(request("/api/run-boxes", input, owner.cookie));
    assert.equal(response.status, 400, JSON.stringify(input));
  }
  assert.equal((await boxes.POST(request("/api/run-boxes", environment({ projectId: "other-project" }), owner.cookie))).status, 403);
  assert.equal(await requestCount(), before);
});

test("one-step owner path records the request with server-derived requester and queues one approved job idempotently", async () => {
  const before = await requestCount();
  const created = await boxes.POST(request("/api/run-boxes", environment(), owner.cookie));
  assert.equal(created.status, 201);
  const { decision, job } = await created.json();
  assert.equal(decision.outcome, "approved");
  assert.equal(decision.project_role, "owner");
  assert.equal(job.state, "queued");
  assert.equal(job.provider, "runpod");
  assert.equal(job.profile_id, "runpod-rtx-4090");
  assert.equal(job.max_duration_minutes, 120);
  assert.equal(job.repo_url, "https://example.com/repo");
  assert.equal(await requestCount(), before + 1);
  const saved = (await store.getState()).projects.find((item) => item.id === projectId).resourceRequests.find((item) => item.id === decision.resource_request_id);
  assert.equal(saved.kind, "gpu");
  assert.deepEqual(saved.requestedBy, { employeeId: owner.id, organizationId: fixture.organization.id, projectRoleAtRequest: "owner" });
  assert.equal(saved.computePreference.provider, "runpod");
  assert.equal(saved.computePreference.maxHourlyUsd, 1);

  const retry = await boxes.POST(request("/api/run-boxes", environment(), owner.cookie));
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).job.id, job.id);
  assert.equal(await requestCount(), before + 1);
  assert.equal((await boxes.POST(request("/api/run-boxes", environment({ durationHours: 1 }), owner.cookie))).status, 409);
  const second = await boxes.POST(request("/api/run-boxes", environment({ idempotencyKey: "env-runpod-2" }), owner.cookie));
  assert.equal(second.status, 409);
  assert.match((await second.json()).error, /Runpod run box is already active/);
  assert.equal(await requestCount(), before + 1);
  const listed = await (await boxes.GET(request(`/api/run-boxes?projectId=${projectId}`, null, owner.cookie))).json();
  assert.ok(listed.jobs.some((item) => item.id === job.id && item.resource_request_id === decision.resource_request_id));
});

test("one-step member path records a denied decision without a job, once under concurrent retries", async () => {
  const before = await requestCount();
  const input = environment({ profileId: "g6-l4-small", durationHours: 1, idempotencyKey: "env-member-1" });
  const responses = await Promise.all([1, 2, 3].map(() => boxes.POST(request("/api/run-boxes", input, member.cookie))));
  const bodies = await Promise.all(responses.map((response) => response.json()));
  for (const [index, response] of responses.entries()) {
    assert.equal(response.status, 200);
    assert.equal(bodies[index].job, null);
    assert.equal(bodies[index].decision.outcome, "denied");
    assert.equal(bodies[index].decision.reason, "Project member cannot allocate a run box");
    assert.equal(bodies[index].decision.id, bodies[0].decision.id);
  }
  assert.equal(await requestCount(), before + 1);
  const saved = (await store.getState()).projects.find((item) => item.id === projectId).resourceRequests.at(-1);
  assert.equal(saved.requestedBy.employeeId, member.id);
  assert.equal(saved.requestedBy.projectRoleAtRequest, "member");
  // Another employee cannot replay a member's key to read or alter that decision.
  assert.equal((await boxes.POST(request("/api/run-boxes", input, owner.cookie))).status, 409);
});

const { migrateRunBoxJobs } = await import(path.join(directory, "run-box-jobs.mjs"));
migrateRunBoxJobs(db);
const dockerSupported = (() => {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_box_job'").get();
  return Boolean(table?.sql.includes("'docker-local'"));
})();

test("one-step local Docker sandbox path queues a CPU-only run box", {
  skip: !dockerSupported && "TODO: enable when lib/run-box-jobs.mjs supports the docker-local provider",
}, async () => {
  const created = await boxes.POST(request("/api/run-boxes", environment({ profileId: "local-docker-sandbox", durationHours: 1, idempotencyKey: "env-docker-1" }), owner.cookie));
  assert.equal(created.status, 201);
  const { job, decision } = await created.json();
  assert.equal(job.provider, "docker-local");
  assert.equal(job.state, "queued");
  const saved = (await store.getState()).projects.find((item) => item.id === projectId).resourceRequests.find((item) => item.id === decision.resource_request_id);
  assert.equal(saved.kind, "run-box");
  assert.equal(saved.computePreference.provider, "docker-local");
});

test("one-step local Docker sandbox path refuses cleanly while the provider is unsupported", {
  skip: dockerSupported && "docker-local provider is supported",
}, async () => {
  const before = await requestCount();
  const response = await boxes.POST(request("/api/run-boxes", environment({ profileId: "local-docker-sandbox", durationHours: 1, idempotencyKey: "env-docker-unsupported" }), owner.cookie));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not available on this server/);
  assert.equal(await requestCount(), before);
});
