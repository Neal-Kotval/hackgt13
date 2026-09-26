import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateRunBoxJobs, saveRunBoxDecision, requestRunBoxStop } from "../lib/run-box-jobs.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";
import { migrateAwsGpuEvidence } from "../lib/aws-gpu-evidence.mjs";

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  migrateRunBoxJobs(db);
  migrateAwsGpuEvidence(db);
  db.prepare("INSERT INTO user VALUES ('employee-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "decision-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "org-1", projectRole: "owner",
    provider: "aws-ec2", maxDurationMinutes: 60,
    repoUrl: "https://github.com/example/repo.git",
  });
  return { db, job };
}

test("approved owner job reaches ready only after provider verification", async () => {
  const { db, job } = setup();
  const calls = [];
  const provider = {
    async identifyWorker() { calls.push("identity"); },
    async allocate() { calls.push("allocate"); return { InstanceId: "i-1234567890abcdef0" }; },
    async inspect() { calls.push("inspect"); return { InstanceId: "i-1234567890abcdef0", State: { Name: "running" } }; },
    async verify(instanceId, approvedJob) {
      calls.push("verify");
      assert.equal(approvedJob.repo_url, "https://github.com/example/repo.git");
      return {
        instanceId, evidenceRef: "ssm:11111111-1111-4111-8111-111111111111",
        commandId: "11111111-1111-4111-8111-111111111111",
        remoteAccount: "ec2-user", remoteUid: 1000,
        workspace: `/home/ec2-user/agentcloud/${job.id}`,
        repositoryRevision: "a".repeat(40), gpuDevice: "NVIDIA L4", nvidiaProbe: "GPU 0: NVIDIA L4",
        workloadValue: 4, correct: true, cpuMs: 1.25, gpuMs: 0.75,
        durationMs: 2230, exitCode: 0, outputSha256: "b".repeat(64),
      };
    },
  };
  const result = await workOneAwsGpuJob(db, provider, { workerId: "worker-1" });
  assert.equal(result.state, "ready");
  assert.deepEqual(calls, ["identity", "allocate", "inspect", "verify"]);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "ready");
  assert.equal(db.prepare("SELECT repo_revision FROM run_box_job WHERE id = ?").get(job.id).repo_revision, "a".repeat(40));
  const proof = db.prepare("SELECT * FROM aws_gpu_verification WHERE job_id = ?").get(job.id);
  assert.equal(proof.gpu_device, "NVIDIA L4");
  assert.equal(proof.cpu_ms, 1.25);
  assert.equal(proof.gpu_ms, 0.75);
  assert.equal(proof.correctness, 1);
});

test("revoked owner membership prevents allocation", async () => {
  const { db, job } = setup();
  db.prepare("DELETE FROM member WHERE userId = 'employee-1'").run();
  let launched = false;
  const provider = { async identifyWorker() {}, async allocate() { launched = true; } };
  await assert.rejects(workOneAwsGpuJob(db, provider, { workerId: "worker-1" }), /invalid before launch/);
  assert.equal(launched, false);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
});

test("a queued job past its approved deadline cannot launch", async () => {
  const { db, job } = setup();
  db.prepare("UPDATE run_box_job SET created_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 61 * 60_000).toISOString(), job.id);
  let launched = false;
  const provider = { async identifyWorker() {}, async allocate() { launched = true; } };
  await assert.rejects(workOneAwsGpuJob(db, provider, { workerId: "worker-1" }), /invalid before launch/);
  assert.equal(launched, false);
});

test("a provider success without repository revision and workload proof never becomes ready", async () => {
  const { db, job } = setup();
  const provider = {
    async identifyWorker() {},
    async allocate() { return { InstanceId: "i-1234567890abcdef0" }; },
    async inspect() { return { InstanceId: "i-1234567890abcdef0", State: { Name: "running" } }; },
    async verify() { return { evidenceRef: "ssm:unproven" }; },
  };
  await assert.rejects(workOneAwsGpuJob(db, provider, { workerId: "worker-1" }), /Invalid repository revision/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM aws_gpu_verification").get().total, 0);
});

test("queued cancellation is stopped without invoking EC2", async () => {
  const { db, job } = setup();
  requestRunBoxStop(db, job.id, "employee-1");
  const provider = { async identifyWorker() {}, async allocate() { throw new Error("must not allocate"); } };
  const result = await workOneAwsGpuJob(db, provider, { workerId: "worker-1" });
  assert.equal(result.state, "stopped");
  assert.equal(result.evidenceRef, `job:never-allocated:${job.id}`);
});

test("stop after an allocation attempt waits for reconciler EBS proof", async () => {
  const { db, job } = setup();
  const calls = [];
  const provider = {
    async identifyWorker() {},
    async allocate() {
      calls.push("allocate");
      requestRunBoxStop(db, job.id, "employee-1");
      return { InstanceId: "i-1234567890abcdef0" };
    },
    async terminate() { throw new Error("worker must defer termination to reconciler"); },
  };
  const result = await workOneAwsGpuJob(db, provider, { workerId: "worker-1" });
  assert.equal(result.state, "stopping");
  assert.deepEqual(calls, ["allocate"]);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopping");
});
