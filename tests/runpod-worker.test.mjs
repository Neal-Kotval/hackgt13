import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateRunBoxJobs, requestRunBoxStop, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { migrateRunpodEvidence } from "../lib/runpod-evidence.mjs";
import { migrateRunpodCleanup } from "../lib/runpod-reconcile.mjs";
import { preflightRunpod, workOneRunpodJob } from "../lib/runpod-worker.mjs";
import { runpodPodName } from "../lib/runpod-provider.mjs";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  migrateRunBoxJobs(db);
  migrateRunpodEvidence(db);
  migrateRunpodCleanup(db);
  db.prepare("INSERT INTO user VALUES ('employee-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "idem-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "org-1", projectRole: "owner",
    provider: "runpod", profileId: "runpod-rtx-4090", maxDurationMinutes: 60,
    repoUrl: "https://example.com/repo.git",
  });
  return { db, job };
}

function provider(job, overrides = {}) {
  const calls = [];
  const expiresAt = new Date(Math.floor((Date.parse(job.created_at) + job.max_duration_minutes * 60_000) / 1_000) * 1_000);
  const pod = { id: "pod123", name: runpodPodName(job.id, expiresAt), status: "RUNNING",
    gpuId: "NVIDIA GeForce RTX 4090", gpuCount: 1,
    image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404", cloud: "SECURE", diskGb: 50,
    ssh: { direct: { host: "203.0.113.10", port: 30222, username: "root" } } };
  return { calls,
    async listGpuTypes() { calls.push("catalog"); return [{ id: "NVIDIA GeForce RTX 4090", availability: "HIGH", secureHourlyUsd: .49 }]; },
    async listPods() { calls.push("list"); return []; },
    async createPod(input, { onBeforePost }) { await onBeforePost(); calls.push(["create", input]); return pod; },
    async getPod(id) { calls.push(["get", id]); return pod; }, ...overrides };
}

function proof(jobId) {
  return { uid: 1000, account: "agentcloud", workspace: `/home/agentcloud/agentcloud/${jobId}`,
    repo_sha: "a".repeat(40), gpu_device: "NVIDIA GeForce RTX 4090", nvidia_probe: "GPU 0: NVIDIA GeForce RTX 4090",
    workload_value: 4, correct: true, cpu_ms: 1.5, gpu_ms: .8, elapsed_ms: 2000,
    outputSha256: "b".repeat(64), evidenceRef: `ssh:${jobId}:${"b".repeat(64)}` };
}

test("Runpod preflight requires catalog price, availability, and no other managed Pod", async () => {
  const { db, job } = setup();
  const service = provider(job);
  assert.equal((await preflightRunpod(service, job)).hourlyUsd, .49);
  await assert.rejects(preflightRunpod(provider(job, { async listGpuTypes() {
    return [{ id: "NVIDIA GeForce RTX 4090", availability: "HIGH", secureHourlyUsd: null }];
  } }), job), /price unavailable/);
  await assert.rejects(preflightRunpod(provider(job, { async listPods() {
    return [{ name: "agentcloud-another-job", id: "other" }];
  } }), job), /Another managed Runpod Pod/);
  db.close();
});

test("changed Pod profile cannot be verified or marked ready", async () => {
  const { db, job } = setup();
  const service = provider(job, { async createPod(input, { onBeforePost }) { await onBeforePost(); return { id: "pod123", name: runpodPodName(input.jobId, input.expiresAt),
    gpuId: "NVIDIA A100", gpuCount: 1, image: input.image, cloud: input.cloud, diskGb: input.diskGb }; } });
  await assert.rejects(workOneRunpodJob(db, service, { workerId: "runpod-worker", connection: {},
    checkSshConfig() {}, checkCleanupGuard: async () => true, verify: async () => { throw new Error("must not verify"); } }),
  /no longer matches approved profile/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_gpu_verification").get().count, 0);
  db.close();
});

test("provider lookup failure before POST leaves no ambiguous create marker", async () => {
  const { db, job } = setup();
  const service = provider(job, { async createPod() { throw new Error("Runpod list unavailable"); } });
  await assert.rejects(workOneRunpodJob(db, service, { workerId: "runpod-worker", connection: {},
    checkSshConfig() {}, checkCleanupGuard: async () => true, verify: async () => {} }), /list unavailable/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_create_attempt").get().count, 0);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  db.close();
});

test("approved Runpod job reaches ready only after SSH and durable GPU proof", async () => {
  const { db, job } = setup();
  const service = provider(job);
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker",
    connection: { keyFile: "/private/key", knownHostsFile: "/private/hosts", publicKey: "ssh-ed25519 AAAA" },
    checkSshConfig() {}, checkCleanupGuard: async () => true, verify: async (approved, connection) => {
      assert.equal(approved.repo_url, "https://example.com/repo.git");
      assert.equal(connection.host, "203.0.113.10");
      return proof(job.id);
    } });
  assert.equal(result.state, "ready");
  assert.equal(db.prepare("SELECT repo_revision FROM run_box_job WHERE id = ?").get(job.id).repo_revision, "a".repeat(40));
  assert.equal(db.prepare("SELECT gpu_device FROM runpod_gpu_verification WHERE job_id = ?").get(job.id).gpu_device, "NVIDIA GeForce RTX 4090");
  assert.equal(service.calls.filter((call) => Array.isArray(call) && call[0] === "create").length, 1);
  assert.equal(service.calls.find((call) => Array.isArray(call) && call[0] === "create")[1].expiresAt,
    new Date(Math.floor((Date.parse(job.created_at) + job.max_duration_minutes * 60_000) / 1_000) * 1_000).toISOString());
  db.close();
});

test("missing SSH host pin leaves a visible retry without another Pod create", async () => {
  const { db, job } = setup();
  const service = provider(job);
  const settings = { workerId: "runpod-worker", connection: {}, checkSshConfig() {},
    checkCleanupGuard: async () => true,
    verify: async () => { throw new Error("Host key verification failed"); } };
  const first = await workOneRunpodJob(db, service, settings);
  assert.equal(first.state, "verifying");
  assert.equal(first.retry, true);
  assert.match(db.prepare("SELECT reason FROM runpod_connection_wait WHERE job_id = ?").get(job.id).reason, /pinned host key/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "verifying");
  await workOneRunpodJob(db, service, settings);
  assert.equal(service.calls.filter((call) => Array.isArray(call) && call[0] === "create").length, 1);
  assert.equal(db.prepare("SELECT attempts FROM run_box_job WHERE id = ?").get(job.id).attempts, 2);
  db.close();
});

test("missing independent cleanup guard blocks Runpod POST before catalog checks", async () => {
  const { db, job } = setup();
  const service = provider(job);
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker",
    verify: async () => { throw new Error("must not verify"); } });
  assert.equal(result.state, "allocating");
  assert.equal(result.retry, true);
  assert.deepEqual(service.calls, []);
  assert.match(db.prepare("SELECT reason FROM runpod_connection_wait WHERE job_id = ?").get(job.id).reason, /cleanup guard unavailable/);
  db.close();
});

test("guard losing freshness during catalog preflight blocks Runpod POST", async () => {
  const { db, job } = setup();
  const service = provider(job);
  let checks = 0;
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker", connection: {},
    checkSshConfig() {}, checkCleanupGuard: async () => ++checks === 1,
    verify: async () => { throw new Error("must not verify"); } });
  assert.equal(result.state, "allocating");
  assert.equal(result.retry, true);
  assert.equal(checks, 2);
  assert.equal(service.calls.some((call) => Array.isArray(call) && call[0] === "create"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_create_attempt").get().count, 0);
  db.close();
});

test("stop request before allocation does not create a Pod", async () => {
  const { db, job } = setup();
  requestRunBoxStop(db, job.id, "owner");
  const service = provider(job);
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker", verify: async () => {} });
  assert.equal(result.state, "stopping");
  assert.equal(service.calls.length, 0);
  db.close();
});
