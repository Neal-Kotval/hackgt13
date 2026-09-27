import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import * as jobs from "../lib/run-box-jobs.mjs";
import { migrateRunBoxCleanup, reconcileAwsRunBoxes } from "../lib/run-box-reconcile.mjs";
import { setAwsApproval } from "../lib/aws-organization-approval.mjs";

const { claimRunBoxJob, migrateRunBoxJobs, recordRunBoxAllocation, requestRunBoxStop, saveRunBoxDecision, transitionRunBoxJob } = jobs;

// HAC-168: owners were refused new AWS/Runpod environments ("An AWS run box is already
// active") by a job that was failed or stuck in `stopping`, with no way to clear it:
// once a stop was requested the Environments page offered no further action.
function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateRunBoxJobs(db);
  migrateRunBoxCleanup(db);
  db.exec("CREATE TABLE organization (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO organization VALUES ('organization-1')").run();
  setAwsApproval(db, { organizationId: "organization-1", approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: "admin" });
  return db;
}

let sequence = 0;
function decide(db, provider = "aws-ec2") {
  sequence += 1;
  return saveRunBoxDecision(db, {
    idempotencyKey: `force-${sequence}`, resourceRequestId: `resource-force-${sequence}`, projectId: "project-1",
    employeeId: "owner-1", organizationId: "organization-1", projectRole: "owner", provider,
    ...(provider === "aws-ec2" ? { profileId: "aws-cpu" } : { profileId: "runpod-rtx-4090" }),
    maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git",
  });
}

function state(db, id) { return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id); }
const expireLease = (db, id) => db.prepare("UPDATE run_box_job SET lease_expires_at = ? WHERE id = ?")
  .run(new Date(Date.now() - 1_000).toISOString(), id);

function provider(instances) {
  const calls = [];
  return {
    calls,
    async listManagedInstances() { return instances; },
    async listManagedVolumes() { return []; },
    async inspectInstance(id) { return instances.find((item) => item.InstanceId === id) || null; },
    async terminateInstance(id) { calls.push(["terminate", id]); return { state: "terminated" }; },
    async inspectVolumes(ids) { return ids.map((id) => ({ id, state: "deleted" })); },
  };
}

test("a stop requested before any claim closes at once on force stop, with attribution, and unblocks AWS", () => {
  const db = database();
  try {
    const { job } = decide(db);
    requestRunBoxStop(db, job.id, "owner-1");
    assert.equal(state(db, job.id).state, "stopping");
    assert.throws(() => decide(db), /active cloud environment limit/);
    assert.equal(typeof jobs.forceStopRunBoxJob, "function", "owners have no force stop");
    const result = jobs.forceStopRunBoxJob(db, job.id, "owner-2");
    assert.equal(result.outcome, "stopped");
    const closed = state(db, job.id);
    assert.equal(closed.state, "stopped");
    assert.equal(closed.force_stop_requested_by, "owner-2");
    assert.ok(closed.force_stop_requested_at);
    const last = db.prepare("SELECT * FROM run_box_transition WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id);
    assert.equal(last.actor, "owner-2");
    assert.equal(last.evidence_ref, `job:never-allocated:${job.id}:force-stop`);
    assert.equal(decide(db).decision.outcome, "approved");
  } finally { db.close(); }
});

test("force stop on a failed job with a launched instance requests termination and never just closes it", async () => {
  const db = database();
  try {
    const { job } = decide(db);
    claimRunBoxJob(db, "worker", new Date(), 60_000, "aws-ec2");
    recordRunBoxAllocation(db, job.id, "worker", "aws-ec2", "i-launched");
    transitionRunBoxJob(db, job.id, "failed", "worker", { reason: "CPU bootstrap failed at step codex" });
    expireLease(db, job.id);
    assert.throws(() => decide(db), /active cloud environment limit/);

    const result = jobs.forceStopRunBoxJob(db, job.id, "owner-1");
    assert.equal(result.outcome, "termination-requested");
    const pending = state(db, job.id);
    assert.equal(pending.state, "failed", "a DB flag must not stand in for termination");
    assert.ok(pending.stop_requested_at);
    assert.equal(pending.force_stop_requested_by, "owner-1");
    assert.throws(() => decide(db), /active cloud environment limit/, "still billable until the provider confirms");
    // Repeating it is harmless and adds no second audit row.
    const rows = db.prepare("SELECT COUNT(*) AS count FROM run_box_transition WHERE job_id = ?").get(job.id).count;
    assert.equal(jobs.forceStopRunBoxJob(db, job.id, "owner-1").outcome, "termination-requested");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_transition WHERE job_id = ?").get(job.id).count, rows);

    // The existing reconciler performs the actual EC2 termination.
    const service = provider([{ InstanceId: "i-launched", State: { Name: "running" }, volumeIds: ["vol-1"], Tags: [
      { Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" },
      { Key: "AgentCloudJobId", Value: job.id },
      { Key: "AgentCloudCreatedAt", Value: new Date().toISOString() },
      { Key: "AgentCloudExpiresAt", Value: new Date(Date.now() + 30 * 60_000).toISOString() },
    ] }]);
    await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop: requestRunBoxStop });
    assert.deepEqual(service.calls, [["terminate", "i-launched"]]);
    assert.equal(state(db, job.id).state, "stopped");
    assert.equal(decide(db).decision.outcome, "approved");
  } finally { db.close(); }
});

test("force stop never closes a job a worker is actively holding", () => {
  const db = database();
  try {
    const { job } = decide(db);
    claimRunBoxJob(db, "worker", new Date(), 10 * 60_000, "aws-ec2");
    const result = jobs.forceStopRunBoxJob(db, job.id, "owner-1");
    assert.equal(result.outcome, "termination-requested");
    assert.equal(state(db, job.id).state, "allocating");
    assert.ok(state(db, job.id).stop_requested_at);
  } finally { db.close(); }
});

test("a force-stop click does not restart the quiet period before a pre-launch failure closes", async () => {
  const db = database();
  try {
    const { job } = decide(db);
    claimRunBoxJob(db, "worker", new Date(), 60_000, "aws-ec2");
    transitionRunBoxJob(db, job.id, "failed", "worker", { reason: "No registered device SSH keys for this project" });
    requestRunBoxStop(db, job.id, "owner-1");
    db.prepare("UPDATE run_box_transition SET created_at = ? WHERE job_id = ?").run(new Date(Date.now() - 20 * 60_000).toISOString(), job.id);
    expireLease(db, job.id);
    assert.equal(jobs.forceStopRunBoxJob(db, job.id, "owner-1").outcome, "termination-requested");
    await reconcileAwsRunBoxes(db, provider([]), { workerId: "worker", requestStop: requestRunBoxStop });
    assert.equal(state(db, job.id).state, "stopped");
  } finally { db.close(); }
});

test("a stopped job reports stopped and a missing job reports nothing", () => {
  const db = database();
  try {
    const { job } = decide(db);
    requestRunBoxStop(db, job.id, "owner-1");
    jobs.forceStopRunBoxJob(db, job.id, "owner-1");
    assert.equal(jobs.forceStopRunBoxJob(db, job.id, "owner-1").outcome, "stopped");
    assert.equal(jobs.forceStopRunBoxJob(db, "missing", "owner-1"), null);
  } finally { db.close(); }
});
