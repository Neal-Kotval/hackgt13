import { runpodJobMarker } from "./runpod-provider.mjs";
import { transitionRunBoxJob } from "./run-box-jobs.mjs";

const MANAGED_NAME = /^agentcloud-([a-f0-9-]{36})$/;

export function migrateRunpodCleanup(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS runpod_cleanup (
    pod_id TEXT PRIMARY KEY, job_id TEXT, status TEXT NOT NULL CHECK(status IN ('retry', 'stopped')),
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, evidence_ref TEXT, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runpod_create_attempt (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id), attempted_at TEXT NOT NULL
  );`);
}

function record(db, podId, jobId, status, error = null, evidenceRef = null) {
  db.prepare(`INSERT INTO runpod_cleanup (pod_id, job_id, status, attempts, last_error, evidence_ref, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(pod_id) DO UPDATE SET job_id=excluded.job_id, status=excluded.status,
      attempts=runpod_cleanup.attempts+1, last_error=excluded.last_error,
      evidence_ref=excluded.evidence_ref, updated_at=excluded.updated_at`)
    .run(podId, jobId, status, error, evidenceRef, new Date().toISOString());
}

function claimLease(db, jobId, workerId, now) {
  return db.transaction(() => {
    const job = db.prepare("SELECT worker_id, lease_expires_at, state FROM run_box_job WHERE id = ? AND provider = 'runpod'").get(jobId);
    if (!job || job.state === "stopped") return false;
    if (job.lease_expires_at > now.toISOString() && job.worker_id !== workerId) return false;
    db.prepare("UPDATE run_box_job SET worker_id = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
      .run(workerId, new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString(), jobId);
    return true;
  })();
}

function markStopped(db, job, workerId, evidenceRef, now) {
  if (!claimLease(db, job.id, workerId, now)) return false;
  const current = db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id);
  if (current.state === "stopped") return true;
  if (current.state !== "stopping") transitionRunBoxJob(db, job.id, "stopping", workerId, { reason: "Runpod cleanup confirmed" });
  transitionRunBoxJob(db, job.id, "stopped", workerId, { evidenceRef });
  return true;
}

export async function reconcileRunpodJobs(db, provider, { workerId, requestStop, now = new Date(),
  checkCleanupGuard = async () => false } = {}) {
  if (!workerId || typeof requestStop !== "function" || !(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new Error("Runpod reconciliation requires worker, stop operation, and valid clock");
  const pods = await provider.listPods();
  let guardActive = false;
  try { guardActive = await checkCleanupGuard() === true; } catch { /* Fail closed on an unavailable guard. */ }
  const jobs = db.prepare("SELECT * FROM run_box_job WHERE provider = 'runpod' AND state != 'stopped'").all();
  const byJob = new Map(jobs.map((job) => [job.id, job]));
  const managed = pods.filter((pod) => MANAGED_NAME.test(pod.name));
  const counts = new Map();
  for (const pod of managed) {
    const jobId = MANAGED_NAME.exec(pod.name)[1];
    counts.set(jobId, (counts.get(jobId) || 0) + 1);
  }
  const outcomes = [];
  for (const pod of managed) {
    const jobId = MANAGED_NAME.exec(pod.name)[1];
    const job = byJob.get(jobId);
    const duplicate = counts.get(jobId) > 1 && pod.id !== job?.provider_resource_id;
    const orphan = !job || duplicate;
    const expired = job && now.getTime() >= Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
    if (!orphan && !expired && guardActive && !job.stop_requested_at && job.state !== "failed") continue;
    if (job && (expired || job.state === "failed" || !guardActive) && !job.stop_requested_at)
      requestStop(db, job.id, "runpod-reconciler");
    try {
      await provider.terminatePod(pod.id);
      if (await provider.getPod(pod.id)) throw new Error("Runpod Pod still exists after termination request");
      const evidenceRef = `runpod:terminated:${pod.id}:absent`;
      if (orphan) {
        record(db, pod.id, null, "stopped", null, evidenceRef);
        outcomes.push({ podId: pod.id, jobId: null, status: "stopped", orphan: true });
      } else if (markStopped(db, job, workerId, evidenceRef, now)) {
        record(db, pod.id, job.id, "stopped", null, evidenceRef);
        outcomes.push({ podId: pod.id, jobId: job.id, status: "stopped" });
      } else {
        record(db, pod.id, job.id, "retry", "Waiting for active worker lease");
        outcomes.push({ podId: pod.id, jobId: job.id, status: "retry", error: "Waiting for active worker lease" });
      }
    } catch (error) {
      const message = String(error?.message || error).slice(0, 256);
      record(db, pod.id, job?.id || null, "retry", message);
      outcomes.push({ podId: pod.id, jobId: job?.id || null, status: "retry", error: message });
    }
  }
  for (const job of jobs) {
    if (!job.provider_resource_id || managed.some((pod) => pod.id === job.provider_resource_id)) continue;
    if (!job.stop_requested_at) requestStop(db, job.id, "runpod-reconciler");
    try {
      if (await provider.getPod(job.provider_resource_id)) throw new Error("Runpod Pod is absent from inventory but still resolves by ID");
      const evidenceRef = `runpod:absent:${job.provider_resource_id}`;
      if (!markStopped(db, job, workerId, evidenceRef, now)) throw new Error("Waiting for active worker lease");
      record(db, job.provider_resource_id, job.id, "stopped", null, evidenceRef);
      outcomes.push({ podId: job.provider_resource_id, jobId: job.id, status: "stopped" });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 256);
      record(db, job.provider_resource_id, job.id, "retry", message);
      outcomes.push({ podId: job.provider_resource_id, jobId: job.id, status: "retry", error: message });
    }
  }
  // An attempted create without a durable Pod ID is ambiguous. Never infer
  // cleanup from one empty list; retain the failed/stopping job for review.
  for (const job of jobs) {
    if (job.provider_resource_id || !job.stop_requested_at ||
        managed.some((pod) => pod.name === runpodJobMarker(job.id))) continue;
    const attempted = db.prepare("SELECT 1 FROM runpod_create_attempt WHERE job_id = ?").get(job.id);
    if (attempted) {
      outcomes.push({ podId: null, jobId: job.id, status: "retry", error: "Runpod allocation outcome is unconfirmed" });
    } else {
      const evidenceRef = `runpod:never-created:${job.id}`;
      if (markStopped(db, job, workerId, evidenceRef, now))
        outcomes.push({ podId: null, jobId: job.id, status: "stopped" });
      else outcomes.push({ podId: null, jobId: job.id, status: "retry", error: "Waiting for active worker lease" });
    }
  }
  return outcomes;
}
