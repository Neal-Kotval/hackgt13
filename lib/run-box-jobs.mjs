import { createHash, randomUUID } from "node:crypto";

const providers = new Set(["ssh-host", "aws-ec2"]);
const states = new Set(["queued", "allocating", "connecting", "verifying", "ready", "stopping", "stopped", "failed"]);
const nextStates = {
  allocating: new Set(["stopping", "failed"]),
  connecting: new Set(["verifying", "stopping", "failed"]),
  verifying: new Set(["ready", "stopping", "failed"]),
  ready: new Set(["stopping", "failed"]),
  stopping: new Set(["stopped", "failed"]),
  failed: new Set(["stopping"]),
};

function required(value, name, limit = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function row(db, id) {
  return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id) || null;
}

export function migrateRunBoxJobs(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_box_decision (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      resource_request_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_role TEXT NOT NULL CHECK(project_role IN ('owner', 'member')),
      provider TEXT NOT NULL CHECK(provider IN ('ssh-host', 'aws-ec2')),
      max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
      outcome TEXT NOT NULL CHECK(outcome IN ('approved', 'denied')),
      reason TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_box_job (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL UNIQUE REFERENCES run_box_decision(id),
      project_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('ssh-host', 'aws-ec2')),
      max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
      state TEXT NOT NULL CHECK(state IN ('queued', 'allocating', 'connecting', 'verifying', 'ready', 'stopping', 'stopped', 'failed')),
      provider_resource_id TEXT,
      worker_id TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider, provider_resource_id)
    );
    CREATE INDEX IF NOT EXISTS run_box_job_claim ON run_box_job(state, lease_expires_at, created_at);
    CREATE TABLE IF NOT EXISTS run_box_transition (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES run_box_job(id),
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT,
      evidence_ref TEXT,
      created_at TEXT NOT NULL
    );
  `);
}

export function saveRunBoxDecision(db, input) {
  const projectRole = input.projectRole;
  const outcome = projectRole === "owner" ? "approved" : "denied";
  const reason = projectRole === "owner" ? "Project owner may allocate a run box" : "Project member cannot allocate a run box";
  const request = {
    idempotencyKey: required(input.idempotencyKey, "idempotency key", 128),
    resourceRequestId: required(input.resourceRequestId, "resource request ID"),
    projectId: required(input.projectId, "project ID"),
    employeeId: required(input.employeeId, "employee ID"),
    organizationId: required(input.organizationId, "organization ID"),
    projectRole,
    provider: input.provider,
    maxDurationMinutes: input.maxDurationMinutes,
    outcome,
    reason,
    policyVersion: "runbox-v1",
  };
  if (!["owner", "member"].includes(request.projectRole) || !providers.has(request.provider) || ![60, 120].includes(request.maxDurationMinutes)) {
    throw new Error("Invalid run-box decision");
  }
  const hash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM run_box_decision WHERE idempotency_key = ?").get(request.idempotencyKey);
    if (existing) {
      if (existing.request_hash !== hash) throw new Error("Idempotency key reused for a different decision");
      return { decision: existing, job: db.prepare("SELECT * FROM run_box_job WHERE decision_id = ?").get(existing.id) || null };
    }
    if (db.prepare("SELECT id FROM run_box_decision WHERE resource_request_id = ?").get(request.resourceRequestId)) {
      throw new Error("Resource request already has a run-box decision");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO run_box_decision
      (id, idempotency_key, request_hash, resource_request_id, project_id, employee_id, organization_id, project_role, provider, max_duration_minutes, outcome, reason, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, request.idempotencyKey, hash, request.resourceRequestId, request.projectId, request.employeeId, request.organizationId,
      request.projectRole, request.provider, request.maxDurationMinutes, request.outcome, request.reason, request.policyVersion, now,
    );
    if (request.outcome === "approved") {
      const jobId = randomUUID();
      db.prepare(`INSERT INTO run_box_job (id, decision_id, project_id, provider, max_duration_minutes, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(jobId, id, request.projectId, request.provider, request.maxDurationMinutes, now, now);
      db.prepare(`INSERT INTO run_box_transition (job_id, to_state, actor, reason, created_at)
        VALUES (?, 'queued', 'policy', ?, ?)`).run(jobId, request.reason, now);
    }
    return { decision: db.prepare("SELECT * FROM run_box_decision WHERE id = ?").get(id), job: db.prepare("SELECT * FROM run_box_job WHERE decision_id = ?").get(id) || null };
  })();
}

export function claimRunBoxJob(db, workerId, now = new Date(), leaseMs = 60_000) {
  required(workerId, "worker ID");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isInteger(leaseMs) || leaseMs < 1_000) {
    throw new Error("Invalid worker lease");
  }
  return db.transaction(() => {
    const job = db.prepare(`SELECT * FROM run_box_job WHERE state = 'queued'
      OR (state IN ('allocating', 'connecting', 'verifying', 'stopping') AND lease_expires_at <= ?)
      ORDER BY created_at, id LIMIT 1`).get(now.toISOString());
    if (!job) return null;
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    db.prepare(`UPDATE run_box_job SET state = ?, worker_id = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`)
      .run(job.state === "queued" ? "allocating" : job.state, workerId, expires, now.toISOString(), job.id);
    if (job.state === "queued") {
      db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, created_at)
        VALUES (?, 'queued', 'allocating', ?, ?)`).run(job.id, workerId, now.toISOString());
    }
    // The stable job ID is the provider idempotency token on every retry.
    return row(db, job.id);
  })();
}

export function recordRunBoxAllocation(db, jobId, workerId, provider, resourceId) {
  required(jobId, "job ID");
  required(workerId, "worker ID");
  required(resourceId, "provider resource ID");
  if (!providers.has(provider)) throw new Error("Invalid provider");
  return db.transaction(() => {
    const job = row(db, jobId);
    if (!job || job.provider !== provider) throw new Error("Provider mismatch");
    if (job.provider_resource_id) {
      if (job.provider_resource_id !== resourceId) throw new Error("Job already has another provider resource");
      return job;
    }
    if (job.state !== "allocating" || job.worker_id !== workerId || job.lease_expires_at <= new Date().toISOString()) {
      throw new Error("Worker does not own an active allocation lease");
    }
    const now = new Date().toISOString();
    db.prepare(`UPDATE run_box_job SET state = 'connecting', provider_resource_id = ?, updated_at = ? WHERE id = ?`)
      .run(resourceId, now, jobId);
    db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, evidence_ref, created_at)
      VALUES (?, 'allocating', 'connecting', ?, ?, ?)`).run(jobId, workerId, resourceId, now);
    return row(db, jobId);
  })();
}

export function transitionRunBoxJob(db, jobId, nextState, actor, { reason = null, evidenceRef = null } = {}) {
  required(jobId, "job ID");
  required(actor, "actor");
  if (!states.has(nextState)) throw new Error("Invalid run-box state");
  if (reason !== null) required(reason, "transition reason");
  if (evidenceRef !== null) required(evidenceRef, "evidence reference");
  return db.transaction(() => {
    const job = row(db, jobId);
    if (!job) throw new Error("Run-box job not found");
    if (job.state === nextState) return job;
    if (!nextStates[job.state]?.has(nextState)) throw new Error(`Invalid transition ${job.state} -> ${nextState}`);
    if (["ready", "stopped"].includes(nextState) && !evidenceRef) throw new Error("Verified transition requires evidence reference");
    const now = new Date().toISOString();
    db.prepare("UPDATE run_box_job SET state = ?, updated_at = ? WHERE id = ?").run(nextState, now, jobId);
    db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, reason, evidence_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jobId, job.state, nextState, actor, reason, evidenceRef, now);
    return row(db, jobId);
  })();
}
