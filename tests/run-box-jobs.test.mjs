import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  claimRunBoxJob,
  migrateRunBoxJobs,
  recordRunBoxAllocation,
  recordRunBoxRevision,
  requestRunBoxStop,
  saveRunBoxDecision,
  transitionRunBoxJob,
} from "../lib/run-box-jobs.mjs";

function database() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateRunBoxJobs(db);
  migrateRunBoxJobs(db);
  return db;
}

function request(overrides = {}) {
  return {
    idempotencyKey: "request-12345678",
    resourceRequestId: "resource-request-1",
    projectId: "project-1",
    employeeId: "employee-1",
    organizationId: "organization-1",
    projectRole: "owner",
    provider: "aws-ec2",
    maxDurationMinutes: 120,
    repoUrl: "https://example.com/repo.git",
    ...overrides,
  };
}

test("member denial persists a decision without a billable job", () => {
  const db = database();
  try {
    const result = saveRunBoxDecision(db, request({ projectRole: "member" }));
    assert.equal(result.decision.outcome, "denied");
    assert.equal(result.job, null);
    assert.equal(claimRunBoxJob(db, "worker-1"), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_job").get().count, 0);
  } finally {
    db.close();
  }
});

test("approved job pins a validated server repository URL in the decision", () => {
  const db = database();
  try {
    assert.throws(() => saveRunBoxDecision(db, request({ repoUrl: "https://user:secret@example.com/repo.git" })), /Invalid repository URL/);
    const { job } = saveRunBoxDecision(db, request());
    assert.equal(job.repo_url, "https://example.com/repo.git");
    assert.equal(job.repo_revision, null);
    assert.throws(() => saveRunBoxDecision(db, request({ repoUrl: "https://example.com/other.git" })), /Idempotency key reused/);
  } finally {
    db.close();
  }
});

test("stop request survives queued and active jobs, and provider claim stays scoped", () => {
  const db = database();
  try {
    const first = saveRunBoxDecision(db, request({ provider: "ssh-host" }));
    const queuedStop = requestRunBoxStop(db, first.job.id, "owner-1");
    assert.equal(queuedStop.state, "stopping");
    assert.equal(queuedStop.stop_requested_by, "owner-1");
    assert.equal(requestRunBoxStop(db, first.job.id, "owner-2").stop_requested_by, "owner-1");
    assert.equal(claimRunBoxJob(db, "gpu-worker", new Date(), 60_000, "aws-ec2"), null);
    assert.equal(claimRunBoxJob(db, "ssh-worker", new Date(), 60_000, "ssh-host").id, first.job.id);
    const second = saveRunBoxDecision(db, request({ idempotencyKey: "request-2", resourceRequestId: "resource-2" }));
    claimRunBoxJob(db, "gpu-worker-2", new Date(), 60_000, "aws-ec2");
    recordRunBoxAllocation(db, second.job.id, "gpu-worker-2", "aws-ec2", "i-456");
    const activeStop = requestRunBoxStop(db, second.job.id, "owner-1");
    assert.equal(activeStop.state, "connecting");
    assert.ok(activeStop.stop_requested_at);
    transitionRunBoxJob(db, second.job.id, "verifying", "gpu-worker-2");
    assert.throws(() => transitionRunBoxJob(db, second.job.id, "ready", "gpu-worker-2", { evidenceRef: "check" }), /Cannot mark a stopping job ready/);
  } finally {
    db.close();
  }
});

test("migration upgrades existing job tables and stale workers cannot transition", () => {
  const old = new Database(":memory:");
  old.exec(`CREATE TABLE run_box_job (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
    provider TEXT NOT NULL, max_duration_minutes INTEGER NOT NULL, state TEXT NOT NULL,
    provider_resource_id TEXT, worker_id TEXT, lease_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(provider, provider_resource_id))`);
  migrateRunBoxJobs(old);
  const columns = old.prepare("PRAGMA table_info(run_box_job)").all().map((item) => item.name);
  assert.ok(columns.includes("stop_requested_at"));
  assert.ok(columns.includes("stop_requested_by"));
  assert.ok(columns.includes("repo_url"));
  assert.ok(columns.includes("repo_revision"));
  const { job } = saveRunBoxDecision(old, request());
  claimRunBoxJob(old, "worker-owner");
  assert.throws(() => transitionRunBoxJob(old, job.id, "failed", "stale-worker"), /active job lease/);
  assert.equal(transitionRunBoxJob(old, job.id, "failed", "worker-owner").state, "failed");
  old.close();
});

test("approved request is atomic and idempotent across retries", () => {
  const db = database();
  try {
    const first = saveRunBoxDecision(db, request());
    const retry = saveRunBoxDecision(db, request());
    assert.equal(first.decision.outcome, "approved");
    assert.equal(first.job.id, retry.job.id);
    assert.equal(first.job.decision_id, retry.decision.id);
    assert.equal(first.job.max_duration_minutes, 120);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_job").get().count, 1);
    assert.throws(() => saveRunBoxDecision(db, request({ provider: "ssh-host" })), /Idempotency key reused/);
    assert.throws(() => saveRunBoxDecision(db, request({ idempotencyKey: "another-request-key" })), /already has a run-box decision/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_job").get().count, 1);
  } finally {
    db.close();
  }
});

test("expired claim keeps one provider token and rejects stale worker", () => {
  const db = database();
  try {
    const { job } = saveRunBoxDecision(db, request());
    const now = new Date();
    const first = claimRunBoxJob(db, "worker-1", now);
    assert.equal(first.id, job.id);
    assert.equal(first.attempts, 1);
    assert.equal(claimRunBoxJob(db, "worker-2", new Date(now.getTime() + 30_000)), null);
    const recovered = claimRunBoxJob(db, "worker-2", new Date(now.getTime() + 61_000));
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.attempts, 2);
    assert.throws(() => recordRunBoxAllocation(db, job.id, "worker-1", "aws-ec2", "i-123"), /does not own/);
    assert.throws(() => recordRunBoxAllocation(db, job.id, "worker-2", "ssh-host", "host-1"), /Provider mismatch/);
    assert.equal(recordRunBoxAllocation(db, job.id, "worker-2", "aws-ec2", "i-123").state, "connecting");
    assert.equal(recordRunBoxAllocation(db, job.id, "worker-2", "aws-ec2", "i-123").provider_resource_id, "i-123");
    assert.throws(() => recordRunBoxAllocation(db, job.id, "worker-2", "aws-ec2", "i-456"), /another provider resource/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_job").get().count, 1);
  } finally {
    db.close();
  }
});

test("ready and stopped require evidence, with recorded state changes", () => {
  const db = database();
  try {
    const { job } = saveRunBoxDecision(db, request());
    claimRunBoxJob(db, "worker-1");
    recordRunBoxAllocation(db, job.id, "worker-1", "aws-ec2", "i-123");
    transitionRunBoxJob(db, job.id, "verifying", "worker-1");
    assert.throws(() => transitionRunBoxJob(db, job.id, "ready", "worker-1"), /requires evidence/);
    assert.throws(() => transitionRunBoxJob(db, job.id, "ready", "worker-1", { evidenceRef: "gpu-check" }), /repository revision required/);
    const revision = "a".repeat(40);
    assert.equal(recordRunBoxRevision(db, job.id, "worker-1", revision).repo_revision, revision);
    assert.throws(() => recordRunBoxRevision(db, job.id, "worker-1", "b".repeat(40)), /another repository revision/);
    assert.equal(transitionRunBoxJob(db, job.id, "ready", "worker-1", { evidenceRef: "gpu-check-1" }).state, "ready");
    assert.equal(transitionRunBoxJob(db, job.id, "stopping", "worker-1").state, "stopping");
    assert.throws(() => transitionRunBoxJob(db, job.id, "stopped", "worker-1"), /requires evidence/);
    assert.equal(transitionRunBoxJob(db, job.id, "stopped", "worker-1", { evidenceRef: "ec2-terminated-1" }).state, "stopped");
    assert.throws(() => transitionRunBoxJob(db, job.id, "ready", "worker-1", { evidenceRef: "x" }), /Invalid transition/);
    const changes = db.prepare("SELECT from_state, to_state, evidence_ref FROM run_box_transition WHERE job_id = ? ORDER BY id").all(job.id);
    assert.deepEqual(changes.map((item) => item.to_state), ["queued", "allocating", "connecting", "verifying", "verifying", "ready", "stopping", "stopped"]);
    assert.equal(changes.at(-1).evidence_ref, "ec2-terminated-1");
  } finally {
    db.close();
  }
});

test("worker restart recovers the same allocated box from durable storage", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-run-box-"));
  const filename = path.join(directory, "jobs.sqlite");
  try {
    let db = new Database(filename);
    db.pragma("foreign_keys = ON");
    migrateRunBoxJobs(db);
    const { job } = saveRunBoxDecision(db, request());
    const beforeCrash = new Date();
    claimRunBoxJob(db, "worker-before-crash", beforeCrash);
    // The provider identity was durably recorded before the worker stopped.
    assert.equal(recordRunBoxAllocation(db, job.id, "worker-before-crash", "aws-ec2", "i-123").state, "connecting");
    db.close();

    db = new Database(filename);
    db.pragma("foreign_keys = ON");
    migrateRunBoxJobs(db);
    const recovered = claimRunBoxJob(db, "worker-after-crash", new Date(beforeCrash.getTime() + 61_000));
    assert.equal(recovered.id, job.id);
    assert.equal(recovered.state, "connecting");
    assert.equal(recovered.provider_resource_id, "i-123");
    assert.equal(recovered.attempts, 2);
    assert.equal(saveRunBoxDecision(db, request()).job.id, job.id);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_job").get().count, 1);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
