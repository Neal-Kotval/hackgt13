import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { prepareAuth } from "./auth-fixture.mjs";
import { registerContainerTemplate } from "../lib/container-templates.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-run-box-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
for (const name of ["store", "http", "resource-profiles"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
for (const name of ["run-box-jobs", "run-box-ssh", "ssh-keys", "agent-check", "container-templates", "aws-organization-approval", "aws-cpu-ssh-access"])
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
    `from './${name}${["auth", "run-box-jobs", "run-box-ssh", "ssh-keys", "container-templates", "aws-organization-approval", "aws-cpu-ssh-access"].includes(name) ? ".mjs" : ".js"}'`);
  await writeFile(path.join(directory, outputName), code);
  return import(path.join(directory, outputName));
}
const boxes = await route("../app/api/run-boxes/route.ts", "boxes-route.js", 3);
const approvals = await import(path.join(directory, "aws-organization-approval.mjs"));
approvals.setAwsApproval(db, { organizationId: fixture.organization.id, approved: true,
  maxRunMinutes: 120, monthlyMinutes: 1200, actorId: fixture.users[0].id });
const admin = await route("../app/api/admin/aws-approvals/route.ts", "aws-approvals-route.js", 4);
const stop = await route("../app/api/run-boxes/[id]/stop/route.ts", "stop-route.js", 5);
const sshAccess = await route("../app/api/run-boxes/[id]/ssh-access/route.ts", "ssh-access-route.js", 5);
const owner = fixture.users[0];
const member = fixture.users[1];

test("platform operator alone can change AWS organization approval", async () => {
  process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL = owner.email;
  const input = { organizationId: fixture.organization.id, approved: false, maxRunMinutes: 60, monthlyMinutes: 60 };
  assert.equal((await admin.GET(request("/api/admin/aws-approvals", null))).status, 401);
  assert.equal((await admin.POST(request("/api/admin/aws-approvals", input, member.cookie))).status, 403);
  assert.equal((await admin.POST(request("/api/admin/aws-approvals", { ...input, monthlyMinutes: 61 }, owner.cookie))).status, 400);
  const changed = await admin.POST(request("/api/admin/aws-approvals", input, owner.cookie));
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).approval.approved, 0);
  assert.equal((await (await admin.GET(request("/api/admin/aws-approvals", null, owner.cookie))).json()).organizations[0].approved, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM aws_organization_approval_event WHERE organization_id = ?").get(fixture.organization.id).count, 2);
  approvals.setAwsApproval(db, { ...input, approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: owner.id });
  delete process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL;
});
const projectId = (await store.action({ type: "createProject", name: "GPU test", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
fixture.grantMembership(owner.id, projectId, "owner");
fixture.grantMembership(member.id, projectId, "member");
const actor = (user, role) => ({ employeeId: user.id, organizationId: fixture.organization.id, projectRole: role });
async function gpuRequest(user, role, gpuProfileId = "g6-l4-small") {
  return (await store.resourceAction({ type: "requestResource", projectId, kind: "gpu", purpose: "GPU smoke", gpuProfileId, durationHours: 1 }, actor(user, role))).request;
}
function request(url, body, cookie) {
  return new Request(`http://localhost:3000${url}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

test("unapproved organization cannot queue AWS through either request path", async () => {
  approvals.setAwsApproval(db, { organizationId: fixture.organization.id, approved: false,
    maxRunMinutes: 120, monthlyMinutes: 1200, actorId: owner.id });
  try {
    const saved = await gpuRequest(owner, "owner");
    const oldPath = await boxes.POST(request("/api/run-boxes", {
      projectId, resourceRequestId: saved.id, idempotencyKey: "aws-unapproved-saved",
    }, owner.cookie));
    assert.equal(oldPath.status, 200);
    assert.equal((await oldPath.json()).job, null);
    const oneStep = await boxes.POST(request("/api/run-boxes", {
      projectId, profileId: "g6-l4-small", durationHours: 1, idempotencyKey: "aws-unapproved-one-step",
    }, owner.cookie));
    assert.equal(oneStep.status, 200);
    const result = await oneStep.json();
    assert.equal(result.decision.outcome, "denied");
    assert.equal(result.job, null);
  } finally {
    approvals.setAwsApproval(db, { organizationId: fixture.organization.id, approved: true,
      maxRunMinutes: 120, monthlyMinutes: 1200, actorId: owner.id });
  }
});

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
  // Release the single active Runpod slot for later tests (no worker runs here).
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(job.id);
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

test("active Docker sandbox returns actionable conflict without recording another request", async () => {
  const before = await requestCount();
  const input = environment({ profileId: "local-docker-sandbox", durationHours: 1, idempotencyKey: "env-docker-1" });
  const retry = await boxes.POST(request("/api/run-boxes", input, owner.cookie));
  assert.equal(retry.status, 201);
  const existing = (await retry.json()).job;
  registerContainerTemplate(db, { id: "conflict-template", label: "Conflict template", imageRef: "example/codex:1",
    imageId: `sha256:${"c".repeat(64)}`, source: "registry" });
  for (const state of ["queued", "ready", "failed", "stopping"]) {
    db.prepare("UPDATE run_box_job SET state = ? WHERE id = ?").run(state, existing.id);
    for (const profileId of ["local-docker-sandbox", "local-template:conflict-template"]) {
      const response = await boxes.POST(request("/api/run-boxes", { ...input, profileId,
        idempotencyKey: `conflict-${state}-${profileId}` }, owner.cookie));
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /already active.*Use the existing environment or stop it/i);
      assert.equal(await requestCount(), before);
    }
  }
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(existing.id);
  const replacement = await boxes.POST(request("/api/run-boxes", { ...input, idempotencyKey: "docker-after-stop" }, owner.cookie));
  assert.equal(replacement.status, 201);
  assert.notEqual((await replacement.json()).job.id, existing.id);
});

test("imported container template is listed and selectable for a local environment", async () => {
  registerContainerTemplate(db, { id: "codex-custom", label: "Custom Codex", imageRef: "example/codex:1",
    imageId: `sha256:${"b".repeat(64)}`, source: "registry" });
  const project = await store.action({ type: "createProject", name: "Template test",
    repo: "https://example.com/template-repo", compute: "Hosted Linux", template: "blank" });
  fixture.grantMembership(owner.id, project.id, "owner");
  const listed = await boxes.GET(request(`/api/run-boxes?projectId=${project.id}`, null, owner.cookie));
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).templates.find((item) => item.id === "codex-custom").label, "Custom Codex");
  const created = await boxes.POST(request("/api/run-boxes", environment({ projectId: project.id,
    profileId: "local-template:codex-custom", idempotencyKey: "env-template-1" }), owner.cookie));
  assert.equal(created.status, 201);
  const { job } = await created.json();
  assert.equal(job.profile_id, "local-template:codex-custom");
  assert.equal(job.provider, "docker-local");
  const missing = await boxes.POST(request("/api/run-boxes", environment({ projectId: project.id,
    profileId: "local-template:absent", idempotencyKey: "env-template-missing" }), owner.cookie));
  assert.equal(missing.status, 409);
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

test("Runpod approval is owner scoped, profile pinned, and duplicate allocation returns conflict", async () => {
  const saved = await gpuRequest(owner, "owner", "runpod-rtx-4090");
  const input = { projectId, resourceRequestId: saved.id, idempotencyKey: "runpod-approval-1" };
  assert.equal((await boxes.POST(request("/api/run-boxes", input, member.cookie))).status, 403);
  const response = await boxes.POST(request("/api/run-boxes", input, owner.cookie));
  assert.equal(response.status, 201);
  const { decision, job } = await response.json();
  assert.equal(decision.provider, "runpod");
  assert.equal(decision.profile_id, "runpod-rtx-4090");
  assert.equal(job.state, "queued");
  assert.equal(job.provider_resource_id, null);
  const next = await gpuRequest(owner, "owner", "runpod-rtx-4090");
  const duplicate = await boxes.POST(request("/api/run-boxes", {
    projectId, resourceRequestId: next.id, idempotencyKey: "runpod-approval-2",
  }, owner.cookie));
  assert.equal(duplicate.status, 409);
});

test("HAC-166: aws-cpu creation records the requester's CloudFront viewer IPv4 only when trusted", async () => {
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE provider = 'aws-ec2'").run();
  const create = (key, headers = {}) => boxes.POST(new Request("http://localhost:3000/api/run-boxes", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie: owner.cookie, ...headers },
    body: JSON.stringify({ projectId, profileId: "aws-cpu", durationHours: 1, idempotencyKey: key }),
  }));
  const rows = (jobId) => db.prepare("SELECT cidr, source, requested_by, status FROM aws_cpu_ssh_access WHERE job_id = ?").all(jobId);
  delete process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER;
  const untrusted = await create("hac-166-untrusted", { "cloudfront-viewer-address": "8.8.8.8:5000", "x-forwarded-for": "1.1.1.1" });
  assert.equal(untrusted.status, 201);
  const untrustedJob = (await untrusted.json()).job;
  (await import(path.join(directory, "aws-cpu-ssh-access.mjs"))).migrateAwsCpuSshAccess(db);
  assert.deepEqual(rows(untrustedJob.id), []);
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(untrustedJob.id);
  process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER = "1";
  try {
    const spoofed = await create("hac-166-private", { "cloudfront-viewer-address": "10.0.0.8:5000" });
    assert.equal(spoofed.status, 201);
    const spoofedJob = (await spoofed.json()).job;
    assert.deepEqual(rows(spoofedJob.id), []);
    db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(spoofedJob.id);
    const created = await create("hac-166-trusted", { "cloudfront-viewer-address": "8.8.8.8:5000" });
    assert.equal(created.status, 201);
    const job = (await created.json()).job;
    assert.deepEqual(rows(job.id).map((row) => ({ ...row })), [{ cidr: "8.8.8.8/32", source: "create", requested_by: owner.id, status: "pending" }]);
  } finally {
    delete process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER;
  }
});

test("HAC-166: desktop registers its IPv4 for a ready aws-cpu environment", async () => {
  const accessLib = await import(path.join(directory, "aws-cpu-ssh-access.mjs"));
  db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE provider = 'aws-ec2'").run();
  process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER = "1";
  const call = (method, jobId, { cookie = owner.cookie, viewer = "8.8.8.8:5000", headers = {} } = {}) =>
    sshAccess[method](new Request(`http://localhost:3000/api/run-boxes/${jobId}/ssh-access`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(viewer ? { "cloudfront-viewer-address": viewer } : {}), ...headers },
    }), { params: Promise.resolve({ id: jobId }) });
  try {
    const created = await boxes.POST(request("/api/run-boxes", { projectId, profileId: "aws-cpu", durationHours: 1, idempotencyKey: "hac-166-desktop" }, owner.cookie));
    assert.equal(created.status, 201);
    const job = (await created.json()).job;
    const setJob = (fields) => db.prepare(`UPDATE run_box_job SET ${Object.keys(fields).map((key) => `${key} = @${key}`).join(", ")} WHERE id = @id`).run({ ...fields, id: job.id });
    const rows = () => db.prepare("SELECT cidr, source, status FROM aws_cpu_ssh_access WHERE job_id = ? ORDER BY created_at, rowid").all(job.id).map((row) => ({ ...row }));

    // Authentication, origin, membership, state, and profile.
    assert.equal((await call("POST", job.id, { cookie: null })).status, 401);
    assert.equal((await call("POST", job.id, { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await call("POST", "00000000-0000-4000-8000-000000000000")).status, 404);
    const notReady = await call("POST", job.id);
    assert.equal(notReady.status, 409);
    assert.equal((await notReady.json()).code, "not_ready");
    setJob({ state: "ready" });
    setJob({ stop_requested_at: new Date().toISOString() });
    assert.equal((await (await call("POST", job.id)).json()).code, "not_ready");
    setJob({ stop_requested_at: null, profile_id: "g6-l4-small" });
    assert.equal((await (await call("POST", job.id)).json()).code, "not_aws_cpu");
    setJob({ profile_id: "aws-cpu" });
    const otherProject = (await store.action({ type: "createProject", name: "Other", repo: "https://example.com/other", compute: "Hosted Linux", template: "blank" })).id;
    fixture.grantMembership(owner.id, otherProject, "owner");
    setJob({ project_id: otherProject });
    assert.equal((await call("POST", job.id, { cookie: member.cookie })).status, 403);
    setJob({ project_id: projectId });

    // The address comes only from the trusted CloudFront header; never X-Forwarded-For.
    const ipv6 = await call("POST", job.id, { viewer: "2001:db8::1:443", headers: { "x-forwarded-for": "8.8.4.4" } });
    assert.equal(ipv6.status, 409);
    assert.equal((await ipv6.json()).code, "no_ipv4");
    delete process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER;
    const untrusted = await call("POST", job.id);
    assert.equal(untrusted.status, 409);
    assert.equal((await untrusted.json()).code, "address_untrusted");
    process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER = "1";
    assert.deepEqual(rows(), []);

    // A member records a pending address; a repeat is idempotent; applied reports 200.
    const pending = await call("POST", job.id, { cookie: member.cookie });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), { status: "pending", cidr: "8.8.8.8/32" });
    assert.equal((await call("POST", job.id, { cookie: member.cookie })).status, 202);
    assert.deepEqual(rows(), [{ cidr: "8.8.8.8/32", source: "desktop", status: "pending" }]);
    assert.deepEqual((await (await call("GET", job.id, { cookie: member.cookie })).json()).sshAccess, { cidr: "8.8.8.8/32", status: "pending" });
    await accessLib.applyReadyAwsCpuSshAccess(db, { async authorizeSsh(_job, cidr) { return { ruleId: "sgr-0abc", cidr }; } });
    const applied = await call("POST", job.id, { cookie: member.cookie });
    assert.equal(applied.status, 200);
    assert.deepEqual(await applied.json(), { status: "applied", cidr: "8.8.8.8/32" });
    assert.deepEqual((await (await call("GET", job.id)).json()).sshAccess, { cidr: "8.8.8.8/32", status: "applied" });
    assert.equal((await (await call("GET", job.id, { viewer: "1.1.1.1:5000" })).json()).sshAccess.status, "none");

    // At most five active addresses per job; the least recently requested is replaced.
    for (const viewer of ["1.1.1.1", "1.0.0.1", "9.9.9.9", "4.4.4.4", "4.2.2.2"])
      assert.equal((await call("POST", job.id, { viewer: `${viewer}:5000` })).status, 202);
    const active = rows().filter((row) => ["pending", "applied"].includes(row.status));
    assert.equal(active.length, accessLib.MAX_REQUESTER_CIDRS);
    assert.equal(rows().find((row) => row.cidr === "8.8.8.8/32").status, "replaced");
    assert.equal(rows().find((row) => row.cidr === "1.1.1.1/32").status, "pending");
    setJob({ state: "stopped" });
  } finally {
    delete process.env.AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER;
  }
});
