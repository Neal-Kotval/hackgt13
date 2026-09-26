import { transitionRunBoxJob } from "./run-box-jobs.mjs";

const MANAGED_TAGS = { Project: "AgentCloudDemo", AgentCloudAutoExpire: "true" };

function tags(instance) {
  return Object.fromEntries((instance.Tags || []).map(({ Key, Value }) => [Key, Value]));
}

function volumes(instance) {
  return (instance.volumeIds || (instance.BlockDeviceMappings || []).map((entry) => entry.Ebs?.VolumeId))
    .filter(Boolean);
}

function undeleted(observed, expectedIds) {
  const states = new Map(observed.map((volume) => [volume.id, volume.state]));
  return expectedIds.filter((id) => states.get(id) !== "deleted");
}

function managed(instance) {
  const found = tags(instance);
  return Object.entries(MANAGED_TAGS).every(([key, value]) => found[key] === value);
}

function mark(db, instanceId, jobId, volumeIds, status, error = null, evidenceRef = null) {
  const now = new Date().toISOString();
  const prior = db.prepare("SELECT * FROM run_box_cleanup WHERE instance_id = ?").get(instanceId);
  const known = [...new Set([...(prior ? JSON.parse(prior.volume_ids) : []), ...volumeIds])];
  db.prepare(`INSERT INTO run_box_cleanup
    (instance_id, job_id, volume_ids, status, attempts, last_error, evidence_ref, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      job_id = excluded.job_id, volume_ids = excluded.volume_ids, status = excluded.status,
      attempts = run_box_cleanup.attempts + 1, last_error = excluded.last_error,
      evidence_ref = excluded.evidence_ref, updated_at = excluded.updated_at`)
    .run(instanceId, jobId, JSON.stringify(known), status, error, evidenceRef, now);
  return known;
}

function claimCleanupLease(db, jobId, workerId, now = new Date()) {
  return db.transaction(() => {
    const job = db.prepare("SELECT worker_id, lease_expires_at, state FROM run_box_job WHERE id = ? AND provider = 'aws-ec2'").get(jobId);
    if (!job || job.state === "stopped") return false;
    if (job.lease_expires_at > now.toISOString() && job.worker_id !== workerId) return false;
    const expires = new Date(now.getTime() + 10 * 60_000).toISOString();
    db.prepare("UPDATE run_box_job SET worker_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(workerId, expires, now.toISOString(), jobId);
    return true;
  })();
}

function fail(db, instanceId, jobId, volumeIds, error, workerId) {
  mark(db, instanceId, jobId, volumeIds, "retry", String(error?.message || error));
  if (jobId && claimCleanupLease(db, jobId, workerId)) {
    const job = db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(jobId);
    if (job && job.state !== "stopped" && job.state !== "failed") {
      transitionRunBoxJob(db, jobId, "failed", workerId, { reason: `Cleanup pending: ${String(error?.message || error).slice(0, 180)}` });
    }
  }
}

export function migrateRunBoxCleanup(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS run_box_cleanup (
    instance_id TEXT PRIMARY KEY,
    job_id TEXT,
    volume_ids TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('observed', 'retry', 'stopped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    evidence_ref TEXT,
    updated_at TEXT NOT NULL
  );`);
}

// Provider is the scoped EC2 adapter; requestStop is the authenticated job-store operation.
// This is called on worker startup and on each polling cycle, including after a crash.
export async function reconcileAwsRunBoxes(db, provider, { now = new Date(), workerId, requestStop } = {}) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || typeof requestStop !== "function" || !workerId) {
    throw new Error("Reconciliation requires a clock, worker ID, and stop-request operation");
  }
  const observed = await provider.listManagedInstances();
  const jobs = db.prepare("SELECT * FROM run_box_job WHERE provider = 'aws-ec2' AND state != 'stopped'").all();
  const byJob = new Map(jobs.map((job) => [job.id, job]));
  const byInstance = new Map(observed.map((instance) => [instance.InstanceId, instance]));
  const counts = new Map();
  for (const instance of observed) {
    const id = tags(instance).AgentCloudJobId;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const outcomes = [];

  for (const instance of observed) {
    if (!managed(instance)) throw new Error(`Provider returned an unmanaged instance: ${instance.InstanceId}`);
    const previousCleanup = db.prepare("SELECT status FROM run_box_cleanup WHERE instance_id = ?").get(instance.InstanceId);
    if (instance.State?.Name === "terminated" && previousCleanup?.status === "stopped") continue;
    const jobId = tags(instance).AgentCloudJobId;
    const job = byJob.get(jobId);
    const matched = job && (job.provider_resource_id === instance.InstanceId ||
      (!job.provider_resource_id && counts.get(jobId) === 1));
    const knownVolumes = mark(db, instance.InstanceId, matched ? job.id : null, volumes(instance), "observed");
    const taggedExpiry = Date.parse(tags(instance).AgentCloudExpiresAt || "");
    const created = Date.parse(tags(instance).AgentCloudCreatedAt || "");
    const invalidDeadline = !Number.isFinite(taggedExpiry) || !Number.isFinite(created) ||
      taggedExpiry < created || taggedExpiry > created + 120 * 60_000 || created > now.getTime() + 5 * 60_000;
    const jobDeadline = job ? Date.parse(job.created_at) + job.max_duration_minutes * 60_000 : Infinity;
    const expired = invalidDeadline || now.getTime() >= taggedExpiry || now.getTime() >= jobDeadline;
    const orphan = !matched;
    if (matched && expired && !job.stop_requested_at) requestStop(db, job.id, workerId);
    if (!orphan && !expired && !job.stop_requested_at && job.state !== "stopping" && job.state !== "failed") {
      outcomes.push({ instanceId: instance.InstanceId, jobId, status: "active" });
      continue;
    }
    try {
      if (matched && claimCleanupLease(db, job.id, workerId) && job.state !== "stopping") {
        transitionRunBoxJob(db, job.id, "stopping", workerId, { reason: expired ? "Run-box deadline reached" : "Stop requested" });
      }
      if (!knownVolumes.length) throw new Error("No EBS volume IDs captured before termination");
      const terminated = await provider.terminateInstance(instance.InstanceId);
      if (terminated.state !== "terminated" && terminated.state !== "absent") throw new Error("EC2 termination is not confirmed");
      const remaining = undeleted(await provider.inspectVolumes(knownVolumes), knownVolumes);
      if (remaining.length) throw new Error(`EBS deletion unconfirmed: ${remaining.join(", ")}`);
      const evidenceRef = `ec2:terminated:${instance.InstanceId}:ebs-deleted:${knownVolumes.join(",")}`;
      if (matched) {
        if (!claimCleanupLease(db, job.id, workerId)) throw new Error("Waiting for active worker lease to record cleanup");
        const current = db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id);
        if (current.state !== "stopping") transitionRunBoxJob(db, job.id, "stopping", workerId, { reason: "Provider released" });
        transitionRunBoxJob(db, job.id, "stopped", workerId, { evidenceRef });
      }
      mark(db, instance.InstanceId, matched ? job.id : null, knownVolumes, "stopped", null, evidenceRef);
      outcomes.push({ instanceId: instance.InstanceId, jobId: matched ? job.id : null, status: orphan ? "orphan-released" : "stopped" });
    } catch (error) {
      fail(db, instance.InstanceId, matched ? job.id : null, knownVolumes, error, workerId);
      outcomes.push({ instanceId: instance.InstanceId, jobId: matched ? job.id : null, status: "retry", error: String(error?.message || error) });
    }
  }

  // A terminated instance may vanish from EC2's active listing. Persisted volume IDs
  // remain the release proof after that point; absence of an instance alone is not proof.
  for (const job of jobs) {
    if (!job.provider_resource_id || byInstance.has(job.provider_resource_id)) continue;
    const cleanup = db.prepare("SELECT * FROM run_box_cleanup WHERE instance_id = ?").get(job.provider_resource_id);
    if (!cleanup || !JSON.parse(cleanup.volume_ids).length) {
      fail(db, job.provider_resource_id, job.id, [], new Error("Instance absent but EBS volume identity was never captured"), workerId);
      outcomes.push({ instanceId: job.provider_resource_id, jobId: job.id, status: "retry" });
      continue;
    }
    const ids = JSON.parse(cleanup.volume_ids);
    try {
      const instance = await provider.inspectInstance(job.provider_resource_id);
      if (instance && !["terminated", "shutting-down"].includes(instance.State?.Name)) continue;
      if (instance?.State?.Name === "shutting-down") throw new Error("EC2 termination still in progress");
      const remaining = undeleted(await provider.inspectVolumes(ids), ids);
      if (remaining.length) throw new Error(`EBS deletion unconfirmed: ${remaining.join(", ")}`);
      const evidenceRef = `ec2:terminated:${job.provider_resource_id}:ebs-deleted:${ids.join(",")}`;
      if (!claimCleanupLease(db, job.id, workerId)) throw new Error("Waiting for active worker lease to record cleanup");
      const current = db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id);
      if (current.state !== "stopping") transitionRunBoxJob(db, job.id, "stopping", workerId, { reason: "Provider instance no longer active" });
      transitionRunBoxJob(db, job.id, "stopped", workerId, { evidenceRef });
      mark(db, job.provider_resource_id, job.id, ids, "stopped", null, evidenceRef);
      outcomes.push({ instanceId: job.provider_resource_id, jobId: job.id, status: "stopped" });
    } catch (error) {
      fail(db, job.provider_resource_id, job.id, ids, error, workerId);
      outcomes.push({ instanceId: job.provider_resource_id, jobId: job.id, status: "retry", error: String(error?.message || error) });
    }
  }
  return outcomes;
}
