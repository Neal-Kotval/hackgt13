import { createHash, randomUUID } from "node:crypto";
import { awsApprovalReason } from "./aws-organization-approval.mjs";

const providers = new Set(["ssh-host", "aws-ec2", "runpod", "docker-local"]);
const providerCheck = "CHECK(provider IN ('ssh-host', 'aws-ec2', 'runpod', 'docker-local'))";
export const LOCAL_DOCKER_PROFILE_ID = "local-docker-sandbox";
// AWS CPU environment (HAC-125). It reuses provider `aws-ec2` so the single-active
// AWS box guard, EC2 reconciliation, expiry guard, and budget guard all apply. GPU
// aws-ec2 jobs keep a null profile ID, exactly as before.
export const AWS_CPU_PROFILE_ID = "aws-cpu";
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

function repositoryUrl(value) {
  const raw = required(value, "repository URL", 2048);
  let url;
  try { url = new URL(raw); } catch { throw new Error("Invalid repository URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.search || url.hash || !url.pathname || url.pathname === "/")
    throw new Error("Invalid repository URL");
  return url.toString();
}

function row(db, id) {
  return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id) || null;
}

export function getRunBoxJob(db, id) {
  return row(db, required(id, "job ID"));
}

export function listRunBoxJobs(db, projectId) {
  return db.prepare(`SELECT j.*, d.resource_request_id, d.outcome, d.reason AS decision_reason
    FROM run_box_job j JOIN run_box_decision d ON d.id = j.decision_id
    WHERE j.project_id = ? ORDER BY j.created_at DESC, j.id DESC`).all(required(projectId, "project ID"));
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
      provider TEXT NOT NULL ${providerCheck},
      profile_id TEXT,
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
      provider TEXT NOT NULL ${providerCheck},
      profile_id TEXT,
      max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
      state TEXT NOT NULL CHECK(state IN ('queued', 'allocating', 'connecting', 'verifying', 'ready', 'stopping', 'stopped', 'failed')),
      repo_url TEXT,
      repo_revision TEXT,
      provider_resource_id TEXT,
      worker_id TEXT,
      lease_expires_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      stop_requested_at TEXT,
      stop_requested_by TEXT,
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
  // Existing local databases predate stop requests.
  const columns = new Set(db.prepare("PRAGMA table_info(run_box_job)").all().map((column) => column.name));
  if (!columns.has("stop_requested_at")) db.exec("ALTER TABLE run_box_job ADD COLUMN stop_requested_at TEXT");
  if (!columns.has("stop_requested_by")) db.exec("ALTER TABLE run_box_job ADD COLUMN stop_requested_by TEXT");
  if (!columns.has("repo_url")) db.exec("ALTER TABLE run_box_job ADD COLUMN repo_url TEXT");
  if (!columns.has("repo_revision")) db.exec("ALTER TABLE run_box_job ADD COLUMN repo_revision TEXT");
  if (!columns.has("profile_id")) db.exec("ALTER TABLE run_box_job ADD COLUMN profile_id TEXT");
  if (!new Set(db.prepare("PRAGMA table_info(run_box_decision)").all().map((column) => column.name)).has("profile_id"))
    db.exec("ALTER TABLE run_box_decision ADD COLUMN profile_id TEXT");
  const decisionSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_box_decision'").get().sql;
  const jobSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_box_job'").get().sql;
  // Rebuild provider CHECK constraints when a newer provider is missing. This
  // covers databases created before Runpod (HAC-82) and before docker-local (HAC-88).
  if ((decisionSql.includes("CHECK(provider IN") && !decisionSql.includes("'docker-local'")) ||
      (jobSql.includes("CHECK(provider IN") && !jobSql.includes("'docker-local'"))) {
    if (db.inTransaction) throw new Error("Provider schema upgrade requires a top-level migration");
    const foreignKeys = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(`CREATE TABLE run_box_decision_next (
          id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
          resource_request_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, employee_id TEXT NOT NULL,
          organization_id TEXT NOT NULL, project_role TEXT NOT NULL CHECK(project_role IN ('owner', 'member')),
          provider TEXT NOT NULL ${providerCheck},
          profile_id TEXT, max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
          outcome TEXT NOT NULL CHECK(outcome IN ('approved', 'denied')), reason TEXT NOT NULL,
          policy_version TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE run_box_job_next (
          id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES run_box_decision(id),
          project_id TEXT NOT NULL, provider TEXT NOT NULL ${providerCheck},
          profile_id TEXT, max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
          state TEXT NOT NULL CHECK(state IN ('queued', 'allocating', 'connecting', 'verifying', 'ready', 'stopping', 'stopped', 'failed')),
          repo_url TEXT, repo_revision TEXT, provider_resource_id TEXT, worker_id TEXT, lease_expires_at TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, stop_requested_at TEXT, stop_requested_by TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider, provider_resource_id)
        );
        INSERT INTO run_box_decision_next SELECT id, idempotency_key, request_hash, resource_request_id,
          project_id, employee_id, organization_id, project_role, provider, profile_id, max_duration_minutes,
          outcome, reason, policy_version, created_at FROM run_box_decision;
        INSERT INTO run_box_job_next SELECT id, decision_id, project_id, provider, profile_id,
          max_duration_minutes, state, repo_url, repo_revision, provider_resource_id, worker_id,
          lease_expires_at, attempts, stop_requested_at, stop_requested_by, created_at, updated_at FROM run_box_job;
        DROP TABLE run_box_job;
        DROP TABLE run_box_decision;
        ALTER TABLE run_box_decision_next RENAME TO run_box_decision;
        ALTER TABLE run_box_job_next RENAME TO run_box_job;
        CREATE INDEX run_box_job_claim ON run_box_job(state, lease_expires_at, created_at);`);
        if (db.pragma("foreign_key_check").length) throw new Error("Run-box provider migration violated foreign keys");
      })();
    } finally { db.pragma(`foreign_keys = ${foreignKeys ? "ON" : "OFF"}`); }
  }
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
    ...(["runpod", "docker-local"].includes(input.provider) ||
      (input.provider === "aws-ec2" && input.profileId === AWS_CPU_PROFILE_ID) ? { profileId: input.profileId } : {}),
    maxDurationMinutes: input.maxDurationMinutes,
    // A local Docker sandbox may start without a repository; every other provider requires one.
    repoUrl: projectRole !== "owner" ? null
      : input.provider === "docker-local" && (input.repoUrl === undefined || input.repoUrl === null) ? null
        : repositoryUrl(input.repoUrl),
    outcome,
    reason,
    policyVersion: "runbox-v1",
  };
  if (!["owner", "member"].includes(request.projectRole) || !providers.has(request.provider) || ![60, 120].includes(request.maxDurationMinutes)) {
    throw new Error("Invalid run-box decision");
  }
  if (request.provider === "runpod" && !["runpod-rtx-4090", "runpod-budget-gpu"].includes(request.profileId)) throw new Error("Invalid Runpod profile");
  if (request.provider === "docker-local" && request.profileId !== LOCAL_DOCKER_PROFILE_ID &&
      !(typeof request.profileId === "string" && /^local-template:[a-z][a-z0-9-]{1,47}$/.test(request.profileId)))
    throw new Error("Invalid local Docker sandbox profile");
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
    const awsReason = request.provider === "aws-ec2" && request.outcome === "approved"
      ? awsApprovalReason(db, request.organizationId, request.maxDurationMinutes) : null;
    const outcome = awsReason ? "denied" : request.outcome;
    const reason = awsReason || request.reason;
    if (outcome === "approved" && ["aws-ec2", "runpod"].includes(request.provider) &&
      db.prepare("SELECT id FROM run_box_job WHERE provider = ? AND state != 'stopped' LIMIT 1").get(request.provider)) {
      throw new Error(request.provider === "aws-ec2" ? "An AWS run box is already active" : "A Runpod run box is already active");
    }
    // Local sandboxes cost nothing, so the guard is per project rather than per
    // provider. A failed sandbox holds no container (the worker and reconciler remove it).
    if (outcome === "approved" && request.provider === "docker-local" &&
      db.prepare(`SELECT id FROM run_box_job WHERE provider = 'docker-local' AND project_id = ?
        AND state NOT IN ('stopped', 'failed') LIMIT 1`).get(request.projectId)) {
      throw new Error("A local Docker sandbox is already active for this project");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO run_box_decision
      (id, idempotency_key, request_hash, resource_request_id, project_id, employee_id, organization_id, project_role, provider, profile_id, max_duration_minutes, outcome, reason, policy_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, request.idempotencyKey, hash, request.resourceRequestId, request.projectId, request.employeeId, request.organizationId,
      request.projectRole, request.provider, request.profileId ?? null, request.maxDurationMinutes, outcome, reason,
      request.provider === "aws-ec2" ? "aws-org-v1" : request.policyVersion, now,
    );
    if (outcome === "approved") {
      const jobId = randomUUID();
      db.prepare(`INSERT INTO run_box_job (id, decision_id, project_id, provider, profile_id, max_duration_minutes, repo_url, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(jobId, id, request.projectId, request.provider, request.profileId ?? null, request.maxDurationMinutes, request.repoUrl, now, now);
      db.prepare(`INSERT INTO run_box_transition (job_id, to_state, actor, reason, created_at)
        VALUES (?, 'queued', 'policy', ?, ?)`).run(jobId, reason, now);
    }
    return { decision: db.prepare("SELECT * FROM run_box_decision WHERE id = ?").get(id), job: db.prepare("SELECT * FROM run_box_job WHERE decision_id = ?").get(id) || null };
  })();
}

// `profileId` narrows the claim within a provider: undefined claims any profile,
// null claims only jobs without a profile ID, and a string claims only that profile.
export function claimRunBoxJob(db, workerId, now = new Date(), leaseMs = 60_000, provider = null, { profileId } = {}) {
  required(workerId, "worker ID");
  if (provider !== null && !providers.has(provider)) throw new Error("Invalid provider");
  if (profileId !== undefined && profileId !== null && typeof profileId !== "string") throw new Error("Invalid profile filter");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || !Number.isInteger(leaseMs) || leaseMs < 1_000) {
    throw new Error("Invalid worker lease");
  }
  return db.transaction(() => {
    const profileClause = profileId === undefined ? "" : profileId === null ? "AND profile_id IS NULL" : "AND profile_id = @profileId";
    const job = db.prepare(`SELECT * FROM run_box_job WHERE (@provider IS NULL OR provider = @provider) ${profileClause} AND (
      state = 'queued' AND stop_requested_at IS NULL
      OR (state IN ('allocating', 'connecting', 'verifying', 'stopping') AND (lease_expires_at IS NULL OR lease_expires_at <= @now))
      OR (stop_requested_at IS NOT NULL AND state IN ('ready', 'failed')
        AND (lease_expires_at IS NULL OR lease_expires_at <= @now)))
      ORDER BY created_at, id LIMIT 1`).get({ provider, now: now.toISOString(), ...(typeof profileId === "string" ? { profileId } : {}) });
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

export function renewRunBoxLease(db, jobId, workerId, leaseMs = 60_000) {
  required(jobId, "job ID");
  required(workerId, "worker ID");
  if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error("Invalid worker lease");
  const now = new Date();
  const expires = new Date(now.getTime() + leaseMs).toISOString();
  const result = db.prepare(`UPDATE run_box_job SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND worker_id = ? AND lease_expires_at > ?
    AND state != 'stopped'`).run(expires, now.toISOString(), jobId, workerId, now.toISOString());
  if (result.changes !== 1) throw new Error("Worker does not own an active job lease");
  return row(db, jobId);
}

// Releasing a ready or failed lease lets a later stop request be claimed at once.
export function releaseRunBoxLease(db, jobId, workerId) {
  required(jobId, "job ID");
  required(workerId, "worker ID");
  const now = new Date().toISOString();
  const result = db.prepare(`UPDATE run_box_job SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND worker_id = ? AND lease_expires_at > ? AND state != 'stopped'`)
    .run(now, now, jobId, workerId, now);
  if (result.changes !== 1) throw new Error("Worker does not own an active job lease");
  return row(db, jobId);
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

export function recordRunBoxRevision(db, jobId, workerId, revision) {
  required(jobId, "job ID");
  required(workerId, "worker ID");
  if (typeof revision !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision))
    throw new Error("Invalid repository revision");
  return db.transaction(() => {
    const job = row(db, jobId);
    if (!job?.repo_url || !["connecting", "verifying"].includes(job.state) ||
        job.worker_id !== workerId || !job.lease_expires_at || job.lease_expires_at <= new Date().toISOString())
      throw new Error("Worker does not own an active repository verification lease");
    if (job.repo_revision) {
      if (job.repo_revision !== revision) throw new Error("Job already has another repository revision");
      return job;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE run_box_job SET repo_revision = ?, updated_at = ? WHERE id = ?").run(revision, now, jobId);
    db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, evidence_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(jobId, job.state, job.state, workerId, `repo:${revision}`, now);
    return row(db, jobId);
  })();
}

// HAC-153: in-process listeners for newly requested stops (the Codex session
// service closes sessions on that environment). Workers in other processes are
// covered by the session service's periodic state sweep.
const stopListeners = (globalThis.agentcloudRunBoxStopListeners ??= new Set());
export function onRunBoxStopRequested(listener) {
  stopListeners.add(listener);
  return () => stopListeners.delete(listener);
}

export function requestRunBoxStop(db, jobId, actor) {
  required(jobId, "job ID");
  required(actor, "actor");
  const before = db.prepare("SELECT stop_requested_at, state FROM run_box_job WHERE id = ?").get(jobId);
  const job = requestRunBoxStopRow(db, jobId, actor);
  if (job && before && !before.stop_requested_at && before.state !== "stopped") {
    for (const listener of stopListeners) {
      try { listener(jobId); } catch { /* A listener failure must not undo or block the stop request. */ }
    }
  }
  return job;
}

function requestRunBoxStopRow(db, jobId, actor) {
  required(jobId, "job ID");
  required(actor, "actor");
  return db.transaction(() => {
    const job = row(db, jobId);
    if (!job) return null;
    if (job.state === "stopped" || job.stop_requested_at) return job;
    const now = new Date().toISOString();
    const state = job.state === "queued" ? "stopping" : job.state;
    db.prepare("UPDATE run_box_job SET state = ?, stop_requested_at = ?, stop_requested_by = ?, updated_at = ? WHERE id = ?")
      .run(state, now, actor, now, jobId);
    db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, reason, created_at)
      VALUES (?, ?, ?, ?, 'Stop requested', ?)`).run(jobId, job.state, state, actor, now);
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
    if (job.worker_id !== actor || !job.lease_expires_at || job.lease_expires_at <= new Date().toISOString())
      throw new Error("Worker does not own an active job lease");
    if (!nextStates[job.state]?.has(nextState)) throw new Error(`Invalid transition ${job.state} -> ${nextState}`);
    if (nextState === "ready" && job.stop_requested_at) throw new Error("Cannot mark a stopping job ready");
    if (["ready", "stopped"].includes(nextState) && !evidenceRef) throw new Error("Verified transition requires evidence reference");
    if (nextState === "ready" && (job.provider === "docker-local"
      ? job.repo_url && !job.repo_revision : !job.repo_url || !job.repo_revision))
      throw new Error("Verified repository revision required before ready");
    const now = new Date().toISOString();
    db.prepare("UPDATE run_box_job SET state = ?, updated_at = ? WHERE id = ?").run(nextState, now, jobId);
    db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, reason, evidence_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(jobId, job.state, nextState, actor, reason, evidenceRef, now);
    return row(db, jobId);
  })();
}

// HAC-166: platform-admin force close, run by the worker only after it has confirmed
// that no managed EC2 instance or volume carries the job ID. The state machine is
// bypassed deliberately (any non-stopped state closes), but an active lease held by
// another worker still wins: a create may be in flight there.
export function forceCloseRunBoxJob(db, jobId, workerId, actor, { reason, evidenceRef }) {
  required(jobId, "job ID");
  required(workerId, "worker ID");
  required(actor, "actor");
  required(reason, "transition reason");
  required(evidenceRef, "evidence reference");
  return db.transaction(() => {
    const job = row(db, jobId);
    if (!job) throw new Error("Run-box job not found");
    if (job.state === "stopped") return job;
    const now = new Date().toISOString();
    if (job.lease_expires_at && job.lease_expires_at > now && job.worker_id !== workerId)
      throw new Error("Waiting for another worker's active lease");
    db.prepare(`UPDATE run_box_job SET state = 'stopped', stop_requested_at = COALESCE(stop_requested_at, ?),
      stop_requested_by = COALESCE(stop_requested_by, ?), lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(now, actor, now, jobId);
    db.prepare(`INSERT INTO run_box_transition (job_id, from_state, to_state, actor, reason, evidence_ref, created_at)
      VALUES (?, ?, 'stopped', ?, ?, ?, ?)`).run(jobId, job.state, actor, reason, evidenceRef, now);
    return row(db, jobId);
  })();
}
