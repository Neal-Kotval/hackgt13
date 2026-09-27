import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { claimRunBoxJob, migrateRunBoxJobs, recordRunBoxAllocation, recordRunBoxRevision, saveRunBoxDecision, requestRunBoxStop, transitionRunBoxJob } from "../lib/run-box-jobs.mjs";
import { migrateRunBoxCleanup, reconcileAwsRunBoxes } from "../lib/run-box-reconcile.mjs";
import { setAwsApproval } from "../lib/aws-organization-approval.mjs";

function approve(db) {
  db.exec("CREATE TABLE organization (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO organization VALUES ('organization-1')").run();
  setAwsApproval(db, { organizationId: "organization-1", approved: true,
    maxRunMinutes: 120, monthlyMinutes: 1200, actorId: "platform-admin" });
}

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateRunBoxJobs(db);
  migrateRunBoxCleanup(db);
  approve(db);
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "request-1", resourceRequestId: "resource-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "organization-1", projectRole: "owner",
    provider: "aws-ec2", maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git",
  });
  claimRunBoxJob(db, "worker");
  recordRunBoxAllocation(db, job.id, "worker", "aws-ec2", "i-abc123");
  transitionRunBoxJob(db, job.id, "verifying", "worker");
  recordRunBoxRevision(db, job.id, "worker", "a".repeat(40));
  transitionRunBoxJob(db, job.id, "ready", "worker", { evidenceRef: "ssm:gpu-pass" });
  return { db, job };
}

function instance(jobId, expiry = Date.now() + 30 * 60_000) {
  return {
    InstanceId: "i-abc123", State: { Name: "running" },
    Tags: [
      { Key: "Project", Value: "AgentCloudDemo" },
      { Key: "AgentCloudAutoExpire", Value: "true" },
      { Key: "AgentCloudJobId", Value: jobId },
      { Key: "AgentCloudCreatedAt", Value: new Date(expiry - 30 * 60_000).toISOString() },
      { Key: "AgentCloudExpiresAt", Value: new Date(expiry).toISOString() },
    ],
    volumeIds: ["vol-abc123"],
  };
}

function provider(instances, { failTermination = false, volumeState = "deleted", managedVolumes = [] } = {}) {
  const calls = [];
  return {
    calls,
    async listManagedInstances() { return instances; },
    async listManagedVolumes() { calls.push(["list-volumes"]); return managedVolumes; },
    async inspectInstance(id) { calls.push(["inspect", id]); return instances.find((item) => item.InstanceId === id) || null; },
    async terminateInstance(id) {
      calls.push(["terminate", id]);
      if (failTermination) throw new Error("termination API unavailable");
      return { state: "terminated", instanceId: id, evidenceRef: `ec2:terminated:${id}` };
    },
    async inspectVolumes(ids) { calls.push(["volumes", ids]); return ids.map((id) => ({ id, state: volumeState })); },
  };
}

function failedBeforeAllocation(reason) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateRunBoxJobs(db);
  migrateRunBoxCleanup(db);
  approve(db);
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "preallocation-1", resourceRequestId: "resource-preallocation-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "organization-1", projectRole: "owner",
    provider: "aws-ec2", maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git",
  });
  claimRunBoxJob(db, "worker");
  transitionRunBoxJob(db, job.id, "failed", "worker", { reason });
  requestRunBoxStop(db, job.id, "owner");
  return { db, job };
}

function requestStop(db, jobId, actor = "worker") {
  return requestRunBoxStop(db, jobId, actor);
}

test("active job remains ready until a deadline or stop request", async () => {
  const { db, job } = setup();
  try {
    const service = provider([instance(job.id)]);
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => item.status), ["active"]);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "ready");
    assert.equal(service.calls.length, 0);
  } finally { db.close(); }
});

test("expired job is released only after instance termination and EBS deletion", async () => {
  const { db, job } = setup();
  try {
    const service = provider([instance(job.id, Date.now() - 1_000)]);
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.equal(result[0].status, "stopped");
    assert.equal(db.prepare("SELECT state, stop_requested_at FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
    assert.ok(db.prepare("SELECT stop_requested_at FROM run_box_job WHERE id = ?").get(job.id).stop_requested_at);
    assert.deepEqual(service.calls, [["terminate", "i-abc123"], ["volumes", ["vol-abc123"]]]);
    const cleanup = db.prepare("SELECT * FROM run_box_cleanup WHERE instance_id = 'i-abc123'").get();
    assert.equal(cleanup.status, "stopped");
    assert.match(cleanup.evidence_ref, /ebs-deleted:vol-abc123/);
  } finally { db.close(); }
});

test("termination or EBS failure remains visible and retries", async () => {
  const { db, job } = setup();
  try {
    requestStop(db, job.id);
    const current = instance(job.id);
    const first = await reconcileAwsRunBoxes(db, provider([current], { failTermination: true }), { workerId: "worker", requestStop });
    assert.equal(first[0].status, "retry");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
    assert.match(db.prepare("SELECT last_error FROM run_box_cleanup WHERE instance_id = 'i-abc123'").get().last_error, /unavailable/);
    const second = await reconcileAwsRunBoxes(db, provider([current], { volumeState: "in-use" }), { workerId: "worker", requestStop });
    assert.equal(second[0].status, "retry");
    assert.match(db.prepare("SELECT last_error FROM run_box_cleanup WHERE instance_id = 'i-abc123'").get().last_error, /EBS deletion unconfirmed/);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
    const third = await reconcileAwsRunBoxes(db, provider([current]), { workerId: "worker", requestStop });
    assert.equal(third[0].status, "stopped");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  } finally { db.close(); }
});

test("tagged orphan is detected and released without assigning it to another job", async () => {
  const { db, job } = setup();
  try {
    const orphan = { ...instance("unknown-job", Date.now() - 1_000), InstanceId: "i-orphan" };
    const result = await reconcileAwsRunBoxes(db, provider([orphan]), { workerId: "worker", requestStop });
    assert.equal(result[0].status, "orphan-released");
    assert.equal(db.prepare("SELECT job_id, status FROM run_box_cleanup WHERE instance_id = 'i-orphan'").get().job_id, null);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  } finally { db.close(); }
});

test("restart cannot mark an absent instance stopped until captured EBS volumes are deleted", async () => {
  const { db, job } = setup();
  try {
    requestStop(db, job.id);
    const first = await reconcileAwsRunBoxes(db, provider([instance(job.id)], { volumeState: "in-use" }), { workerId: "worker", requestStop });
    assert.equal(first[0].status, "retry");
    const second = await reconcileAwsRunBoxes(db, provider([], { volumeState: "in-use" }), { workerId: "worker", requestStop });
    assert.equal(second[0].status, "retry");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
    const third = await reconcileAwsRunBoxes(db, provider([]), { workerId: "worker", requestStop });
    assert.equal(third[0].status, "stopped");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  } finally { db.close(); }
});

test("an unrecorded duplicate with a valid job tag is released as an orphan", async () => {
  const { db, job } = setup();
  try {
    const duplicate = { ...instance(job.id), InstanceId: "i-def456", volumeIds: ["vol-def456"] };
    const result = await reconcileAwsRunBoxes(db, provider([instance(job.id), duplicate]), { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => item.status), ["active", "orphan-released"]);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "ready");
    assert.equal(db.prepare("SELECT job_id FROM run_box_cleanup WHERE instance_id = 'i-def456'").get().job_id, null);
  } finally { db.close(); }
});

test("missing EBS identity leaves a visible retry rather than stopped", async () => {
  const { db, job } = setup();
  try {
    requestStop(db, job.id);
    const service = provider([{ ...instance(job.id), volumeIds: [], BlockDeviceMappings: [] }]);
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.equal(result[0].status, "retry");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
    assert.match(db.prepare("SELECT last_error FROM run_box_cleanup WHERE instance_id = 'i-abc123'").get().last_error, /No EBS volume IDs/);
    assert.equal(service.calls.length, 0);
  } finally { db.close(); }
});

test("another worker's active lease defers the stopped transition after release", async () => {
  const { db, job } = setup();
  try {
    requestStop(db, job.id);
    const service = provider([instance(job.id)]);
    const first = await reconcileAwsRunBoxes(db, service, { workerId: "reconciler", requestStop });
    assert.equal(first[0].status, "retry");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "ready");
    assert.match(db.prepare("SELECT last_error FROM run_box_cleanup WHERE instance_id = 'i-abc123'").get().last_error, /worker lease/);
    db.prepare("UPDATE run_box_job SET lease_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1_000).toISOString(), job.id);
    const second = await reconcileAwsRunBoxes(db, service, { workerId: "reconciler", requestStop });
    assert.equal(second[0].status, "stopped");
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  } finally { db.close(); }
});

test("deterministic RunInstances rejection closes only after empty EC2 and EBS inventory", async () => {
  const { db, job } = failedBeforeAllocation("AWS ec2:run-instances Client.InvalidParameterCombination: Free Tier ineligible");
  try {
    const service = provider([]);
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => item.status), ["stopped"]);
    assert.deepEqual(service.calls, [["list-volumes"]]);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
    const cleanup = db.prepare("SELECT * FROM run_box_preallocation_cleanup WHERE job_id = ?").get(job.id);
    assert.equal(cleanup.status, "stopped");
    assert.match(cleanup.evidence_ref, /^run-box-transition:\d+:ec2-inventory-empty$/);
  } finally { db.close(); }
});

test("ambiguous launch error remains failed with visible retry evidence", async () => {
  const { db, job } = failedBeforeAllocation("AWS ec2:run-instances network timeout: reply lost");
  try {
    const service = provider([]);
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => item.status), ["retry"]);
    assert.equal(service.calls.length, 0);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
    assert.match(db.prepare("SELECT last_error FROM run_box_preallocation_cleanup WHERE job_id = ?").get(job.id).last_error,
      /No durable deterministic/);
  } finally { db.close(); }
});

test("historical unstructured Free Tier rejection is not reclassified from instance absence", async () => {
  const { db, job } = failedBeforeAllocation(
    "An error occurred (Client.InvalidParameterCombination) when calling the RunInstances operation: Free Tier ineligible",
  );
  try {
    const result = await reconcileAwsRunBoxes(db, provider([]), { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => item.status), ["retry"]);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  } finally { db.close(); }
});

test("deterministic rejection still waits if any managed EBS volume exists", async () => {
  const { db, job } = failedBeforeAllocation("AWS ec2:run-instances Client.InvalidParameterCombination: Free Tier ineligible");
  try {
    const service = provider([], { managedVolumes: [{ VolumeId: "vol-abc123" }] });
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => item.status), ["retry"]);
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  } finally { db.close(); }
});

// Live incident 2026-09-27: the shared staging worker terminated a box launched by a
// developer's local worker ~7 s after it started, because that job was not in staging's DB.
test("an instance launched by another AgentCloud install is never touched by this reconciler", async () => {
  const { db } = setup();
  try {
    const foreign = { ...instance("job-owned-elsewhere"), InstanceId: "i-foreign",
      Tags: [...instance("job-owned-elsewhere").Tags, { Key: "AgentCloudInstall", Value: "bbbbbbbbbbbbbbbb" }] };
    const service = { ...provider([foreign]), installId: "aaaaaaaaaaaaaaaa" };
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.ok(!result.some((outcome) => outcome.instanceId === "i-foreign"));
    assert.ok(!service.calls.some(([call, id]) => call === "terminate" && id === "i-foreign"));
  } finally { db.close(); }
});

test("an orphan launched by this install is still released", async () => {
  const { db } = setup();
  try {
    const own = { ...instance("lost-job", Date.now() - 1_000), InstanceId: "i-own-orphan",
      Tags: [...instance("lost-job").Tags, { Key: "AgentCloudInstall", Value: "aaaaaaaaaaaaaaaa" }] };
    const service = { ...provider([own]), installId: "aaaaaaaaaaaaaaaa" };
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.equal(result[0].status, "orphan-released");
  } finally { db.close(); }
});

// HAC-166 (live on staging): an aws-cpu job stopped while still queued sat in
// `stopping` forever when no CPU worker claimed it, and the single-active AWS guard
// then refused every new AWS environment.
function stoppedWhileQueued({ profileId = "aws-cpu" } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateRunBoxJobs(db);
  migrateRunBoxCleanup(db);
  approve(db);
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "queued-stop-1", resourceRequestId: "resource-queued-stop-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "organization-1", projectRole: "owner",
    provider: "aws-ec2", ...(profileId ? { profileId } : {}), maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git",
  });
  requestRunBoxStop(db, job.id, "owner");
  return { db, job };
}

function nextAwsDecision(db) {
  return saveRunBoxDecision(db, {
    idempotencyKey: "after-stuck-stop", resourceRequestId: "resource-after-stuck-stop", projectId: "project-1",
    employeeId: "employee-1", organizationId: "organization-1", projectRole: "owner",
    provider: "aws-ec2", profileId: "aws-cpu", maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git",
  });
}

function tagged(jobId, key = "AgentCloudJobId") {
  return [{ Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" }, { Key: key, Value: jobId }];
}

test("a stop requested before allocation closes once EC2 shows nothing for the job, unblocking new AWS requests", async () => {
  const { db, job } = stoppedWhileQueued();
  try {
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopping");
    assert.throws(() => nextAwsDecision(db), /AWS run box is already active/);
    const service = provider([]);
    const result = await reconcileAwsRunBoxes(db, service, { workerId: "worker", requestStop });
    assert.deepEqual(result.map((item) => [item.jobId, item.status]), [[job.id, "stopped"]]);
    assert.ok(service.calls.some(([call]) => call === "list-volumes"));
    const closed = db.prepare("SELECT * FROM run_box_transition WHERE job_id = ? ORDER BY id DESC LIMIT 1").get(job.id);
    assert.equal(closed.to_state, "stopped");
    assert.equal(closed.evidence_ref, `job:never-allocated:${job.id}:ec2-inventory-empty`);
    assert.equal(nextAwsDecision(db).decision.outcome, "approved");
  } finally { db.close(); }
});

test("a pre-allocation stop never closes while a job-tagged instance or volume exists", async () => {
  for (const service of [
    provider([{ ...instance("x"), Tags: tagged("JOB") }]),
    provider([], { managedVolumes: [{ VolumeId: "vol-1", Tags: tagged("JOB") }] }),
  ]) {
    const { db, job } = stoppedWhileQueued();
    try {
      const fixed = JSON.parse(JSON.stringify({ instances: await service.listManagedInstances(), volumes: await service.listManagedVolumes() })
        .replaceAll('"JOB"', JSON.stringify(job.id)));
      const fake = { ...provider(fixed.instances, { managedVolumes: fixed.volumes, volumeState: "in-use", failTermination: true }) };
      await reconcileAwsRunBoxes(db, fake, { workerId: "worker", requestStop });
      assert.notEqual(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
    } finally { db.close(); }
  }
});

test("a pre-allocation stop waits for another worker's lease and for a recent launch attempt", async () => {
  const { db, job } = stoppedWhileQueued();
  try {
    // Another worker holds the job (a create may be in flight).
    db.prepare("UPDATE run_box_job SET worker_id = 'other', lease_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), job.id);
    await reconcileAwsRunBoxes(db, provider([]), { workerId: "worker", requestStop });
    assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopping");
  } finally { db.close(); }

  // Entered allocating (a launch may have been attempted): only a quiet period plus empty
  // job and untagged volume inventory, and no RunInstances error, may close it.
  const attempted = failedBeforeAllocation("CPU launch template missing");
  try {
    const service = provider([]);
    let result = await reconcileAwsRunBoxes(attempted.db, service, { workerId: "worker", requestStop });
    assert.equal(attempted.db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(attempted.job.id).state, "failed");
    assert.ok(result.some((item) => item.status === "retry"));
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    attempted.db.prepare("UPDATE run_box_transition SET created_at = ? WHERE job_id = ?").run(old, attempted.job.id);
    result = await reconcileAwsRunBoxes(attempted.db, provider([], { managedVolumes: [{ VolumeId: "vol-legacy", Tags: tagged("x", "Other") }] }),
      { workerId: "worker", requestStop });
    assert.equal(attempted.db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(attempted.job.id).state, "failed");
    result = await reconcileAwsRunBoxes(attempted.db, provider([]), { workerId: "worker", requestStop });
    assert.equal(attempted.db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(attempted.job.id).state, "stopped");
  } finally { attempted.db.close(); }

  const ambiguous = failedBeforeAllocation("AWS ec2:run-instances network timeout: reply lost");
  try {
    ambiguous.db.prepare("UPDATE run_box_transition SET created_at = ? WHERE job_id = ?")
      .run(new Date(Date.now() - 60 * 60_000).toISOString(), ambiguous.job.id);
    await reconcileAwsRunBoxes(ambiguous.db, provider([]), { workerId: "worker", requestStop });
    assert.equal(ambiguous.db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(ambiguous.job.id).state, "failed");
  } finally { ambiguous.db.close(); }
});
