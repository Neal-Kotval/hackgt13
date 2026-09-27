import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import Database from "better-sqlite3";
import { claimRunBoxJob, migrateRunBoxJobs, releaseRunBoxLease, requestRunBoxStop, saveRunBoxDecision,
  transitionRunBoxJob } from "../lib/run-box-jobs.mjs";
import { setAwsApproval } from "../lib/aws-organization-approval.mjs";
import { listActiveAwsEnvironments, migrateAwsForceClose, processAwsForceCloses,
  requestAwsForceClose } from "../lib/aws-force-close.mjs";
import { prepareAuth } from "./auth-fixture.mjs";

// HAC-166: a platform admin can force close a stuck AWS environment. The web server has
// no AWS credentials, so the request is recorded and the worker acts on its next cycle.

function memoryDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE organization (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);
  db.prepare("INSERT INTO user VALUES ('employee-1', 'owner@example.com')").run();
  db.prepare("INSERT INTO organization VALUES ('org-1', 'Example org')").run();
  migrateRunBoxJobs(db);
  migrateAwsForceClose(db);
  setAwsApproval(db, { organizationId: "org-1", approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: "platform-admin" });
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "force-1", resourceRequestId: "resource-force-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "org-1", projectRole: "owner",
    provider: "aws-ec2", profileId: "aws-cpu", maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git",
  });
  return { db, job };
}

function stuck() {
  const { db, job } = memoryDb();
  claimRunBoxJob(db, "worker-old");
  transitionRunBoxJob(db, job.id, "failed", "worker-old", { reason: "No registered device SSH keys for this project" });
  releaseRunBoxLease(db, job.id, "worker-old");
  return { db, job };
}

const managedTags = [{ Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" }];
function inventory({ instances = [], volumes = [] } = {}) {
  return { async listManagedInstances() { return instances; }, async listManagedVolumes() { return volumes; } };
}
const state = (db, id) => db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(id).state;

test("the admin list shows a stuck job with owner, org, profile, reason, and no instance", () => {
  const { db, job } = stuck();
  try {
    const [row] = listActiveAwsEnvironments(db);
    assert.equal(row.id, job.id);
    assert.equal(row.shortId, job.id.slice(0, 8));
    assert.equal(row.ownerEmail, "owner@example.com");
    assert.equal(row.organizationName, "Example org");
    assert.equal(row.profile, "aws-cpu");
    assert.equal(row.state, "failed");
    assert.match(row.lastReason, /No registered device SSH keys/);
    assert.equal(row.instanceId, null);
    assert.equal(row.forceClose, null);
  } finally { db.close(); }
});

test("a force-close request is idempotent and a stopped job reports closed", () => {
  const { db, job } = stuck();
  try {
    assert.equal(requestAwsForceClose(db, "missing", "admin@example.com"), null);
    assert.equal(requestAwsForceClose(db, job.id, "admin@example.com").status, "requested");
    assert.equal(requestAwsForceClose(db, job.id, "admin@example.com").status, "requested");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM aws_force_close").get().count, 1);
    assert.equal(state(db, job.id), "failed", "the web request never changes job state itself");
  } finally { db.close(); }
});

test("worker force close with no EC2 resources closes the job stopped with admin attribution", async () => {
  const { db, job } = stuck();
  try {
    requestAwsForceClose(db, job.id, "admin@example.com");
    const other = { VolumeId: "vol-other", Tags: [...managedTags, { Key: "AgentCloudJobId", Value: "another-job" }] };
    const result = await processAwsForceCloses(db, inventory({ volumes: [other] }), { workerId: "worker", requestStop: requestRunBoxStop });
    assert.deepEqual(result.map((item) => [item.jobId, item.status]), [[job.id, "closed"]]);
    assert.equal(state(db, job.id), "stopped");
    const closed = db.prepare("SELECT * FROM run_box_transition WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id);
    assert.deepEqual({ actor: closed.actor, reason: closed.reason, evidence: closed.evidence_ref, to: closed.to_state },
      { actor: "admin:admin@example.com", reason: "Force closed by platform admin", evidence: "admin-force-close:no-ec2-resources", to: "stopped" });
    assert.equal(listActiveAwsEnvironments(db)[0].forceClose.status, "closed");
    // Idempotent afterwards: a repeat request on a stopped job reports closed, and a new AWS request is allowed.
    assert.equal(requestAwsForceClose(db, job.id, "admin@example.com").status, "closed");
    assert.deepEqual(await processAwsForceCloses(db, inventory(), { workerId: "worker", requestStop: requestRunBoxStop }), []);
  } finally { db.close(); }
});

test("worker force close with a job-tagged instance requests a normal stop and never closes", async () => {
  const { db, job } = memoryDb();
  try {
    claimRunBoxJob(db, "worker-old");
    releaseRunBoxLease(db, job.id, "worker-old");
    requestAwsForceClose(db, job.id, "admin@example.com");
    const instance = { InstanceId: "i-0abc", State: { Name: "running" }, Tags: [...managedTags, { Key: "AgentCloudJobId", Value: job.id }] };
    const result = await processAwsForceCloses(db, inventory({ instances: [instance] }), { workerId: "worker", requestStop: requestRunBoxStop });
    assert.deepEqual(result.map((item) => [item.jobId, item.status]), [[job.id, "terminating"]]);
    const row = db.prepare("SELECT state, stop_requested_by FROM run_box_job WHERE id = ?").get(job.id);
    assert.notEqual(row.state, "stopped");
    assert.equal(row.stop_requested_by, "admin:admin@example.com");
    // Still tagged on the next cycle: it stays terminating until standard teardown stops the job.
    await processAwsForceCloses(db, inventory({ instances: [instance] }), { workerId: "worker", requestStop: requestRunBoxStop });
    assert.notEqual(state(db, job.id), "stopped");
    assert.equal(listActiveAwsEnvironments(db)[0].forceClose.status, "terminating");
  } finally { db.close(); }
});

test("worker force close waits for another worker's active lease and reports an unavailable inventory", async () => {
  const { db, job } = memoryDb();
  try {
    claimRunBoxJob(db, "worker-other");
    requestAwsForceClose(db, job.id, "admin@example.com");
    let [result] = await processAwsForceCloses(db, inventory(), { workerId: "worker", requestStop: requestRunBoxStop });
    assert.equal(result.status, "requested");
    assert.notEqual(state(db, job.id), "stopped");
    releaseRunBoxLease(db, job.id, "worker-other");
    const broken = { async listManagedInstances() { throw new Error("EC2 unavailable"); }, async listManagedVolumes() { return []; } };
    [result] = await processAwsForceCloses(db, broken, { workerId: "worker", requestStop: requestRunBoxStop });
    assert.equal(result.status, "failed");
    assert.notEqual(state(db, job.id), "stopped");
    [result] = await processAwsForceCloses(db, inventory(), { workerId: "worker", requestStop: requestRunBoxStop });
    assert.equal(result.status, "closed");
  } finally { db.close(); }
});

// Route authorization, through the same transpile harness as tests/run-box-api.test.mjs.
const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-force-close-api-"));
process.env.AGENTCLOUD_DATA_DIR = path.join(directory, "data");
await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
for (const name of ["store", "http", "resource-profiles", "platform-admin"]) {
  const source = await readFile(new URL(`../lib/${name}.ts`, import.meta.url), "utf8");
  await writeFile(path.join(directory, `${name}.js`), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText.replace(/from ["']\.\/([\w-]+)["']/g, "from './$1.js'"));
}
const modules = ["run-box-jobs", "aws-organization-approval", "aws-force-close"];
for (const name of modules) await copyFile(new URL(`../lib/${name}.mjs`, import.meta.url), path.join(directory, `${name}.mjs`));
const fixture = await prepareAuth(directory);
const db = fixture.getDatabase();
async function route(sourcePath, outputName, depth) {
  const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } })
    .outputText.replaceAll("../".repeat(depth) + "lib/", "./")
    .replace(/from ["']\.\/([\w-]+)["']/g, (match, name) => `from './${name}${["auth", ...modules].includes(name) ? ".mjs" : ".js"}'`);
  await writeFile(path.join(directory, outputName), code);
  return import(path.join(directory, outputName));
}
const list = await route("../app/api/admin/aws-environments/route.ts", "aws-environments-route.js", 4);
const force = await route("../app/api/admin/aws-environments/[id]/force-close/route.ts", "force-close-route.js", 6);
const [admin, member] = fixture.users;
after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

function request(url, cookie, method = "GET") {
  return new Request(`http://localhost:3000${url}`, { method,
    headers: { "content-type": "application/json", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}) });
}
const params = (id) => ({ params: Promise.resolve({ id }) });

test("admin AWS environment routes require the platform admin and same origin", async () => {
  process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL = admin.email;
  try {
    const store = await import(path.join(directory, "store.js"));
    const projectId = (await store.action({ type: "createProject", name: "Stuck project", repo: "https://example.com/repo", compute: "Hosted Linux", template: "blank" })).id;
    const approvals = await import(path.join(directory, "aws-organization-approval.mjs"));
    const jobs = await import(path.join(directory, "run-box-jobs.mjs"));
    jobs.migrateRunBoxJobs(db);
    approvals.setAwsApproval(db, { organizationId: fixture.organization.id, approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: admin.id });
    const { job } = jobs.saveRunBoxDecision(db, { idempotencyKey: "route-force-1", resourceRequestId: "route-resource-1", projectId,
      employeeId: admin.id, organizationId: fixture.organization.id, projectRole: "owner", provider: "aws-ec2", profileId: "aws-cpu",
      maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git" });

    assert.equal((await list.GET(request("/api/admin/aws-environments"))).status, 401);
    assert.equal((await list.GET(request("/api/admin/aws-environments", member.cookie))).status, 403);
    const listed = await list.GET(request("/api/admin/aws-environments", admin.cookie));
    assert.equal(listed.status, 200);
    const [row] = (await listed.json()).environments;
    assert.deepEqual([row.id, row.ownerEmail, row.organizationName, row.projectName], [job.id, admin.email, "Test organization", "Stuck project"]);

    const url = `/api/admin/aws-environments/${job.id}/force-close`;
    assert.equal((await force.POST(request(url, member.cookie, "POST"), params(job.id))).status, 403);
    assert.equal((await force.POST(request("/api/admin/aws-environments/unknown/force-close", admin.cookie, "POST"), params("unknown"))).status, 404);
    const crossSite = new Request(`http://localhost:3000${url}`, { method: "POST", body: "{}",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: admin.cookie } });
    assert.equal((await force.POST(crossSite, params(job.id))).status, 403);
    const requested = await force.POST(request(url, admin.cookie, "POST"), params(job.id));
    assert.equal(requested.status, 200);
    assert.equal((await requested.json()).forceClose.status, "requested");
    assert.equal((await (await force.POST(request(url, admin.cookie, "POST"), params(job.id))).json()).forceClose.status, "requested");

    // Already stopped: idempotent success, no state change.
    db.prepare("UPDATE run_box_job SET state = 'stopped' WHERE id = ?").run(job.id);
    const again = await force.POST(request(url, admin.cookie, "POST"), params(job.id));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).forceClose.status, "closed");
  } finally { delete process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL; }
});
