import { claimRunBoxJob, recordRunBoxAllocation, renewRunBoxLease, transitionRunBoxJob } from "./run-box-jobs.mjs";

function current(db, id) {
  return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id);
}

function approvalStillValid(db, job) {
  const decision = db.prepare("SELECT * FROM run_box_decision WHERE id = ?").get(job.decision_id);
  if (!decision || decision.outcome !== "approved" || decision.provider !== "aws-ec2" ||
      decision.project_id !== job.project_id || decision.max_duration_minutes !== job.max_duration_minutes) return false;
  const owner = db.prepare(`SELECT 1 FROM project_organization po
    JOIN member m ON m.organizationId = po.organization_id AND m.userId = ?
    LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
    JOIN user u ON u.id = m.userId
    WHERE po.project_id = ? AND po.organization_id = ? AND u.emailVerified = 1
      AND (m.role IN ('owner', 'admin') OR pm.role = 'owner')`).get(decision.employee_id, job.project_id, decision.organization_id);
  return Boolean(owner);
}

function deferStopToReconciler(db, job, workerId, reason) {
  const attempted = db.prepare("SELECT 1 FROM run_box_transition WHERE job_id = ? AND to_state = 'allocating' LIMIT 1").get(job.id);
  if (job.state !== "stopping") transitionRunBoxJob(db, job.id, "stopping", workerId, { reason });
  if (attempted || job.provider_resource_id) return { jobId: job.id, state: "stopping", evidenceRef: null };
  const evidenceRef = `job:never-allocated:${job.id}`;
  transitionRunBoxJob(db, job.id, "stopped", workerId, { evidenceRef });
  return { jobId: job.id, state: "stopped", evidenceRef };
}

export async function workOneAwsGpuJob(db, provider, { workerId = `gpu-worker-${process.pid}`, now = new Date() } = {}) {
  // The provider filter is a part of the shared claim transaction. A GPU
  // worker must never take ownership of a known-host allocation.
  const job = claimRunBoxJob(db, workerId, now, 10 * 60_000, "aws-ec2");
  if (!job) return null;
  const heartbeat = setInterval(() => {
    try { renewRunBoxLease(db, job.id, workerId, 10 * 60_000); }
    catch { clearInterval(heartbeat); /* The transition guard will reject a lost lease. */ }
  }, 30_000);
  heartbeat.unref();
  try {
    await provider.identifyWorker();
    let fresh = current(db, job.id);
    if (fresh.stop_requested_at || fresh.state === "stopping") {
      return deferStopToReconciler(db, fresh, workerId, "Stop requested");
    }

    if (fresh.state === "allocating") {
      if (!approvalStillValid(db, fresh)) throw new Error("Approval or project owner membership was revoked before launch");
      const allocated = await provider.allocate(fresh);
      fresh = recordRunBoxAllocation(db, job.id, workerId, "aws-ec2", allocated.InstanceId);
    }
    fresh = current(db, job.id);
    if (fresh.stop_requested_at) {
      return deferStopToReconciler(db, fresh, workerId, "Stop requested after allocation");
    }

    const instance = await provider.inspect(fresh);
    if (!instance || instance.State?.Name === "terminated") throw new Error("Allocated EC2 instance is missing");
    if (fresh.state === "connecting") {
      fresh = transitionRunBoxJob(db, job.id, "verifying", workerId, { evidenceRef: `ec2:${instance.InstanceId}` });
    }
    if (fresh.state === "verifying") {
      const evidence = await provider.verify(instance.InstanceId, job.id);
      fresh = current(db, job.id);
      if (fresh.stop_requested_at) {
        return deferStopToReconciler(db, fresh, workerId, "Stop requested during verification");
      }
      transitionRunBoxJob(db, job.id, "ready", workerId, { evidenceRef: evidence.evidenceRef });
      return { jobId: job.id, state: "ready", evidenceRef: evidence.evidenceRef };
    }
    throw new Error(`Worker cannot process state ${fresh.state}`);
  } catch (error) {
    const fresh = current(db, job.id);
    if (fresh && fresh.state !== "stopped" && fresh.state !== "failed") {
      try { transitionRunBoxJob(db, job.id, "failed", workerId, { reason: error.message.slice(0, 256) }); }
      catch { /* A lost lease is handled by the next claimant. */ }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
