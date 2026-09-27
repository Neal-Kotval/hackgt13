// Environment access policy (docs/environment-model-contract.md). Every route that
// reaches a run-box job goes through this module, so the policy lives in one place.
//
// Stable interface (other slices import it; keep names and shapes):
//
//   resolveJobAccess(db, employee, projectId, jobId, { includeDeleted = false } = {})
//     -> { job, meta, permissions, membership, creatorId }
//     `employee` is lib/employee.ts's Employee ({ id, memberships: [{ projectId, role }] }).
//     Throws a RunBoxAccessError (status + message, handled like InputError by
//     lib/http.ts `failure` and lib/codex-service.ts `codexFailure`):
//       403 "Project membership required"   caller is not a member of projectId;
//       404 "Run-box job not found"          no such job in projectId, deleted, or a
//                                            private job the caller did not create.
//     `meta` is effectiveRunBoxMetadata(): { name, visibility, deletedAt, deletedBy, legacy }.
//     `permissions` is { open, stop, manage } (manage = rename, visibility, delete).
//     Callers check the permission they need and answer 403 when it is false.
//
//   jobAccessFields(db, job, access) -> { name, visibility, createdBy, permissions }
//     The fields every job JSON carries.
//
//   listVisibleRunBoxJobs(db, employee, projectId, jobs) -> jobs with those fields,
//     omitting deleted jobs and private jobs the caller did not create.
//
//   runBoxVisibleTo(db, employee, runBoxId) -> boolean, for Codex sessions and chat
//     runs. A runBoxId with no job row returns true: the caller still validates the
//     environment itself (a private job always has a metadata row, so it is never
//     exposed by this fallback).
//
// Policy: private jobs are visible only to their creator. Public jobs are visible to
// every project member, who can open, chat, use the terminal, and stop them; only the
// creator or a project owner can manage them. Deleted jobs are visible to nobody.
// A job without a metadata row predates the policy and is public.

import { getRunBoxJob, migrateRunBoxJobs } from "./run-box-jobs.mjs";
import {
  DEFAULT_NEW_VISIBILITY, createRunBoxMetadata, effectiveRunBoxMetadata, getRunBoxMetadata, migrateRunBoxMetadata,
  normalizeRunBoxName, normalizeRunBoxVisibility,
} from "./run-box-metadata.mjs";

export class RunBoxAccessError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RunBoxAccessError";
    this.status = status;
    this.expose = true;
  }
}

export const NOT_FOUND = "Run-box job not found";

export function migrateRunBoxAccess(db) {
  migrateRunBoxJobs(db);
  migrateRunBoxMetadata(db);
}

export function runBoxCreatorId(db, job) {
  return db.prepare("SELECT employee_id FROM run_box_decision WHERE id = ?").get(job.decision_id)?.employee_id ?? null;
}

// Pure policy: who may do what with a job, given its metadata and the caller.
export function runBoxPermissions(meta, { isCreator, role }) {
  const visible = !meta.deletedAt && (meta.visibility === "public" || isCreator);
  return {
    open: visible,
    stop: visible,
    manage: visible && (isCreator || (meta.visibility === "public" && role === "owner")),
  };
}

function userSummary(db, id) {
  if (!id) return null;
  let row = null;
  try { row = db.prepare('SELECT id, name, email FROM "user" WHERE id = ?').get(id) || null; } catch { row = null; }
  return row ? { id: row.id, name: row.name, email: row.email } : { id, name: "", email: "" };
}

function accessFor(db, employee, job, row = getRunBoxMetadata(db, job.id)) {
  const membership = employee.memberships.find((item) => item.projectId === job.project_id) || null;
  const creatorId = runBoxCreatorId(db, job);
  const meta = effectiveRunBoxMetadata(row);
  const permissions = membership
    ? runBoxPermissions(meta, { isCreator: creatorId === employee.id, role: membership.role })
    : { open: false, stop: false, manage: false };
  return { job, meta, permissions, membership, creatorId };
}

export function resolveJobAccess(db, employee, projectId, jobId, { includeDeleted = false } = {}) {
  const membership = employee.memberships.find((item) => item.projectId === projectId);
  if (typeof projectId !== "string" || !projectId || !membership)
    throw new RunBoxAccessError("Project membership required", 403);
  if (typeof jobId !== "string" || !jobId || jobId.length > 64) throw new RunBoxAccessError(NOT_FOUND, 404);
  migrateRunBoxAccess(db);
  const job = getRunBoxJob(db, jobId);
  if (!job || job.project_id !== projectId) throw new RunBoxAccessError(NOT_FOUND, 404);
  const access = accessFor(db, employee, job);
  if (access.meta.deletedAt && includeDeleted) {
    // Only for idempotent delete: answer as if the job were still there.
    const permissions = runBoxPermissions({ ...access.meta, deletedAt: null },
      { isCreator: access.creatorId === employee.id, role: membership.role });
    if (!permissions.open) throw new RunBoxAccessError(NOT_FOUND, 404);
    return { ...access, permissions };
  }
  if (!access.permissions.open) throw new RunBoxAccessError(NOT_FOUND, 404);
  return access;
}

export function jobAccessFields(db, job, access) {
  return {
    name: access.meta.name,
    visibility: access.meta.visibility,
    createdBy: userSummary(db, access.creatorId),
    permissions: access.permissions,
  };
}

export function listVisibleRunBoxJobs(db, employee, projectId, jobs) {
  migrateRunBoxMetadata(db);
  return jobs.flatMap((job) => {
    if (job.project_id !== projectId) return [];
    const access = accessFor(db, employee, job);
    return access.permissions.open ? [{ ...job, ...jobAccessFields(db, job, access) }] : [];
  });
}

export function runBoxVisibleTo(db, employee, runBoxId) {
  if (typeof runBoxId !== "string" || !runBoxId) return true;
  if (runBoxId.length > 256) return false;
  migrateRunBoxAccess(db);
  const job = getRunBoxJob(db, runBoxId);
  if (!job) return true;
  return accessFor(db, employee, job).permissions.open;
}

// Optional `name` and `visibility` from a create request; 400 on invalid values.
export function createMetadataInput(input) {
  try {
    return {
      name: input.name === undefined ? null : normalizeRunBoxName(input.name),
      visibility: input.visibility === undefined ? DEFAULT_NEW_VISIBILITY : normalizeRunBoxVisibility(input.visibility),
    };
  } catch (error) {
    throw new RunBoxAccessError(error.message, 400);
  }
}

// Records metadata for a newly approved job (idempotent on retries) and returns the
// job JSON with the access fields. A null job (denied decision) stays null.
export function recordCreatedJob(db, employee, job, metadata) {
  if (!job) return job;
  migrateRunBoxMetadata(db);
  createRunBoxMetadata(db, job.id, employee.id, metadata);
  return { ...job, ...jobAccessFields(db, job, accessFor(db, employee, job)) };
}

// Codex sessions and chat runs: a session on a hidden environment does not exist for
// this caller. `session` is a codex-sessions DTO ({ target: { kind, runBoxId } }).
export function sessionVisibleTo(db, employee, session) {
  return session?.target?.kind !== "runBox" || runBoxVisibleTo(db, employee, session.target.runBoxId);
}

export function requireSessionVisible(db, employee, session) {
  if (!sessionVisibleTo(db, employee, session)) throw new RunBoxAccessError("Codex session not found.", 404);
  return session;
}
