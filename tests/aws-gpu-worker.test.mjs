import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateRunBoxJobs, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  migrateRunBoxJobs(db);
  db.prepare("INSERT INTO user VALUES ('employee-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "decision-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "org-1", projectRole: "owner",
    provider: "aws-ec2", maxDurationMinutes: 60,
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
    async verify() { calls.push("verify"); return { evidenceRef: "ssm:verified-1" }; },
  };
  const result = await workOneAwsGpuJob(db, provider, { workerId: "worker-1" });
  assert.equal(result.state, "ready");
  assert.deepEqual(calls, ["identity", "allocate", "inspect", "verify"]);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "ready");
});

test("revoked owner membership prevents allocation", async () => {
  const { db, job } = setup();
  db.prepare("DELETE FROM member WHERE userId = 'employee-1'").run();
  let launched = false;
  const provider = { async identifyWorker() {}, async allocate() { launched = true; } };
  await assert.rejects(workOneAwsGpuJob(db, provider, { workerId: "worker-1" }), /revoked before launch/);
  assert.equal(launched, false);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
});
