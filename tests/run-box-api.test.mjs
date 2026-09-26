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
for (const name of ["run-box-jobs", "run-box-ssh", "ssh-keys"])
  await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
const store = await import(path.join(directory, "store.js"));
async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const prefix = "../".repeat(depth) + "lib/";
  const code = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replaceAll(prefix, "./").replace(/from ["']\.\/([\w-]+)["']/g, (match, name) =>
    `from './${name}${["auth", "run-box-jobs", "run-box-ssh", "ssh-keys"].includes(name) ? ".mjs" : ".js"}'`);
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
