import { forceCloseRunBoxJob } from "./run-box-jobs.mjs";

// HAC-166: platform-admin force close for a stuck AWS environment. The web server has no
// AWS credentials, so it only records the request; the AWS worker acts on its next cycle:
// with nothing in the managed EC2 inventory tagged for the job it closes the job `stopped`;
// otherwise it requests a normal stop so standard teardown (agent cleanup, SSH rule
// revoke, termination, EBS deletion) runs. A job is never closed while a tagged resource exists.

export const FORCE_CLOSE_REASON = "Force closed by platform admin";
export const FORCE_CLOSE_EVIDENCE = "admin-force-close:no-ec2-resources";
const RECENT_MS = 24 * 60 * 60_000;

export function migrateAwsForceClose(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aws_force_close (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('requested', 'terminating', 'closed', 'failed')),
    detail TEXT,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

function tags(resource) {
  return Object.fromEntries((resource.Tags || []).map(({ Key, Value }) => [Key, Value]));
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function setStatus(db, jobId, status, detail = null) {
  db.prepare("UPDATE aws_force_close SET status = ?, detail = ?, updated_at = ? WHERE job_id = ?")
    .run(status, detail ? String(detail).slice(0, 256) : null, new Date().toISOString(), jobId);
}

function forceCloseRow(db, jobId) {
  const row = db.prepare("SELECT * FROM aws_force_close WHERE job_id = ?").get(jobId);
  return row ? { status: row.status, requestedBy: row.requested_by, detail: row.detail, requestedAt: row.requested_at, updatedAt: row.updated_at } : null;
}

// Returns null for an unknown (or non-AWS) job. Repeating a pending request is a no-op;
// a failed one is requested again; a stopped job reports `closed` without a new request.
export function requestAwsForceClose(db, jobId, adminEmail) {
  if (typeof adminEmail !== "string" || !adminEmail.includes("@")) throw new Error("Invalid platform admin");
  migrateAwsForceClose(db);
  return db.transaction(() => {
    const job = db.prepare("SELECT id, state FROM run_box_job WHERE id = ? AND provider = 'aws-ec2'").get(jobId);
    if (!job) return null;
    const existing = forceCloseRow(db, job.id);
    if (job.state === "stopped") {
      if (existing && existing.status !== "closed") setStatus(db, job.id, "closed", "Job already stopped");
      return forceCloseRow(db, job.id) || { status: "closed", requestedBy: adminEmail, detail: "Job already stopped", requestedAt: null, updatedAt: null };
    }
    if (existing && existing.status !== "failed") return existing;
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO aws_force_close (job_id, requested_by, status, detail, requested_at, updated_at)
      VALUES (?, ?, 'requested', NULL, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET requested_by = excluded.requested_by, status = 'requested', detail = NULL,
        requested_at = excluded.requested_at, updated_at = excluded.updated_at`).run(job.id, adminEmail.toLowerCase(), now, now);
    return forceCloseRow(db, job.id);
  })();
}

// Non-stopped AWS jobs, plus jobs force closed in the last day so the outcome stays visible.
export function listActiveAwsEnvironments(db, { now = new Date() } = {}) {
  migrateAwsForceClose(db);
  const cpu = hasTable(db, "aws_cpu_environment");
  const users = hasTable(db, "user");
  const organizations = hasTable(db, "organization");
  const rows = db.prepare(`SELECT j.id, j.profile_id, j.state, j.created_at, j.project_id, j.provider_resource_id,
      d.organization_id, ${users ? "u.email" : "NULL"} AS owner_email, ${organizations ? "o.name" : "NULL"} AS organization_name,
      ${cpu ? "e.instance_id" : "NULL"} AS cpu_instance_id,
      (SELECT reason FROM run_box_transition t WHERE t.job_id = j.id AND t.reason IS NOT NULL ORDER BY t.id DESC LIMIT 1) AS last_reason
    FROM run_box_job j JOIN run_box_decision d ON d.id = j.decision_id
    ${users ? "LEFT JOIN user u ON u.id = d.employee_id" : ""}
    ${organizations ? "LEFT JOIN organization o ON o.id = d.organization_id" : ""}
    ${cpu ? "LEFT JOIN aws_cpu_environment e ON e.job_id = j.id" : ""}
    LEFT JOIN aws_force_close f ON f.job_id = j.id
    WHERE j.provider = 'aws-ec2' AND (j.state != 'stopped' OR f.updated_at > ?)
    ORDER BY j.created_at DESC, j.id DESC`).all(new Date(now.getTime() - RECENT_MS).toISOString());
  return rows.map((row) => ({
    id: row.id,
    shortId: row.id.slice(0, 8),
    ownerEmail: row.owner_email,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    projectId: row.project_id,
    profile: row.profile_id || "gpu",
    state: row.state,
    createdAt: row.created_at,
    lastReason: row.last_reason,
    instanceId: row.provider_resource_id || row.cpu_instance_id || null,
    forceClose: forceCloseRow(db, row.id),
  }));
}

// Called by the AWS worker each cycle, before reconciliation. `provider` is the scoped
// EC2 adapter (listManagedInstances, listManagedVolumes); `requestStop` the job-store stop.
export async function processAwsForceCloses(db, provider, { workerId, requestStop }) {
  if (!workerId || typeof requestStop !== "function") throw new Error("Force close requires a worker ID and stop-request operation");
  migrateAwsForceClose(db);
  const pending = db.prepare("SELECT * FROM aws_force_close WHERE status != 'closed' ORDER BY requested_at").all();
  const outcomes = [];
  let inventory = null;
  for (const request of pending) {
    const actor = `admin:${request.requested_by}`;
    try {
      const job = db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(request.job_id);
      if (!job || job.state === "stopped") {
        setStatus(db, request.job_id, "closed", job ? "Job stopped" : "Job no longer exists");
        outcomes.push({ jobId: request.job_id, status: "closed" });
        continue;
      }
      inventory ??= { instances: await provider.listManagedInstances(), volumes: await provider.listManagedVolumes() };
      if (!Array.isArray(inventory.instances) || !Array.isArray(inventory.volumes)) {
        inventory = null;
        throw new Error("Managed EC2 inventory is unavailable");
      }
      const cpu = hasTable(db, "aws_cpu_environment")
        ? db.prepare("SELECT instance_id FROM aws_cpu_environment WHERE job_id = ?").get(job.id) : null;
      const instances = inventory.instances.filter((item) => tags(item).AgentCloudJobId === job.id).map((item) => item.InstanceId);
      const volumes = inventory.volumes.filter((item) => tags(item).AgentCloudJobId === job.id).map((item) => item.VolumeId);
      const recorded = [job.provider_resource_id, cpu?.instance_id].filter(Boolean);
      if (instances.length || volumes.length || recorded.length) {
        requestStop(db, job.id, actor);
        const resources = [...new Set([...instances, ...recorded, ...volumes])].join(", ");
        setStatus(db, job.id, "terminating", `Standard teardown requested for ${resources}`);
        outcomes.push({ jobId: job.id, status: "terminating" });
        continue;
      }
      try {
        forceCloseRunBoxJob(db, job.id, workerId, actor, { reason: FORCE_CLOSE_REASON, evidenceRef: FORCE_CLOSE_EVIDENCE });
      } catch (error) {
        if (!/another worker's active lease/.test(String(error?.message))) throw error;
        setStatus(db, job.id, "requested", "Waiting for another worker's active lease");
        outcomes.push({ jobId: job.id, status: "requested" });
        continue;
      }
      setStatus(db, job.id, "closed", FORCE_CLOSE_EVIDENCE);
      outcomes.push({ jobId: job.id, status: "closed" });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 256);
      setStatus(db, request.job_id, "failed", message);
      outcomes.push({ jobId: request.job_id, status: "failed", error: message });
    }
  }
  return outcomes;
}
