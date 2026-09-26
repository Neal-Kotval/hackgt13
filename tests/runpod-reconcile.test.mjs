import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimRunBoxJob, migrateRunBoxJobs, recordRunBoxAllocation, requestRunBoxStop,
  saveRunBoxDecision, transitionRunBoxJob } from "../lib/run-box-jobs.mjs";
import { migrateRunpodCleanup, reconcileRunpodJobs } from "../lib/runpod-reconcile.mjs";

function setup({ allocated = true } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateRunBoxJobs(db);
  migrateRunpodCleanup(db);
  const { job } = saveRunBoxDecision(db, { idempotencyKey: "idem", resourceRequestId: "request", projectId: "project",
    employeeId: "employee", organizationId: "org", projectRole: "owner", provider: "runpod",
    profileId: "runpod-rtx-4090", maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git" });
  if (allocated) {
    claimRunBoxJob(db, "worker");
    recordRunBoxAllocation(db, job.id, "worker", "runpod", "pod123");
  }
  return { db, job };
}

function provider(pods, { stillPresent = false, failDelete = false } = {}) {
  const calls = [];
  return { calls,
    async listPods() { calls.push("list"); return pods; },
    async terminatePod(id) { calls.push(["delete", id]); if (failDelete) throw new Error("provider unavailable");
      return { id, terminated: true }; },
    async getPod(id) { calls.push(["get", id]); return stillPresent ? pods.find((pod) => pod.id === id) || null : null; } };
}

test("active Runpod job remains allocated until stop or expiry", async () => {
  const { db, job } = setup();
  const service = provider([{ id: "pod123", name: `agentcloud-${job.id}` }]);
  assert.deepEqual(await reconcileRunpodJobs(db, service, { workerId: "worker", requestStop: requestRunBoxStop,
    checkCleanupGuard: async () => true }), []);
  assert.deepEqual(service.calls, ["list"]);
  db.close();
});

test("loss of independent guard terminates even an otherwise active Pod", async () => {
  const { db, job } = setup();
  const service = provider([{ id: "pod123", name: `agentcloud-${job.id}` }]);
  const result = await reconcileRunpodJobs(db, service, { workerId: "worker", requestStop: requestRunBoxStop });
  assert.equal(result[0].status, "stopped");
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  assert.deepEqual(service.calls.slice(1), [["delete", "pod123"], ["get", "pod123"]]);
  db.close();
});

test("stop waits for Pod disappearance before durable stopped evidence", async () => {
  const { db, job } = setup();
  requestRunBoxStop(db, job.id, "owner");
  const pod = { id: "pod123", name: `agentcloud-${job.id}` };
  const pending = provider([pod], { stillPresent: true });
  assert.equal((await reconcileRunpodJobs(db, pending, { workerId: "worker", requestStop: requestRunBoxStop }))[0].status, "retry");
  assert.notEqual(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  const released = provider([pod]);
  assert.equal((await reconcileRunpodJobs(db, released, { workerId: "worker", requestStop: requestRunBoxStop }))[0].status, "stopped");
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  assert.match(db.prepare("SELECT evidence_ref FROM runpod_cleanup WHERE pod_id = 'pod123'").get().evidence_ref, /runpod:terminated/);
  db.close();
});

test("tagged orphan is terminated but cannot be assigned to a job", async () => {
  const { db, job } = setup({ allocated: false });
  const orphan = { id: "orphan", name: "agentcloud-11111111-1111-4111-8111-111111111111" };
  const result = await reconcileRunpodJobs(db, provider([orphan]), { workerId: "worker", requestStop: requestRunBoxStop });
  assert.deepEqual(result.map((item) => [item.status, item.orphan]), [["stopped", true]]);
  assert.equal(db.prepare("SELECT provider_resource_id FROM run_box_job WHERE id = ?").get(job.id).provider_resource_id, null);
  db.close();
});

test("ambiguous attempted create with no Pod remains visible and never claims cleanup", async () => {
  const { db, job } = setup({ allocated: false });
  claimRunBoxJob(db, "worker");
  db.prepare("INSERT INTO runpod_create_attempt (job_id, attempted_at) VALUES (?, ?)").run(job.id, new Date().toISOString());
  transitionRunBoxJob(db, job.id, "failed", "worker", { reason: "Runpod create outcome ambiguous" });
  requestRunBoxStop(db, job.id, "owner");
  const result = await reconcileRunpodJobs(db, provider([]), { workerId: "worker", requestStop: requestRunBoxStop });
  assert.equal(result[0].status, "retry");
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  db.close();
});

test("guard-blocked job can stop with durable no-create evidence", async () => {
  const { db, job } = setup({ allocated: false });
  claimRunBoxJob(db, "worker");
  requestRunBoxStop(db, job.id, "owner");
  const result = await reconcileRunpodJobs(db, provider([]), { workerId: "worker", requestStop: requestRunBoxStop });
  assert.equal(result[0].status, "stopped");
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  assert.equal(db.prepare("SELECT evidence_ref FROM run_box_transition WHERE job_id = ? AND to_state = 'stopped'").get(job.id).evidence_ref,
    `runpod:never-created:${job.id}`);
  db.close();
});
