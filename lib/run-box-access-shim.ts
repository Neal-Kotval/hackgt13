// TEMPORARY SHIM (slice C, web terminal). Delete at integration and import
// `resolveJobAccess` from `./run-box-access.mjs` (slice A) instead.
//
// Same signature as slice A's function: returns { job, meta, permissions } or throws a
// 404/403 InputError. Until slice A lands there is no visibility metadata, so this keeps
// today's behavior (every project member may open a job in their project); only
// project owners get stop/manage, as the existing stop route does.
import { getRunBoxJob, migrateRunBoxJobs } from "./run-box-jobs.mjs";
import { requireMembership, type Employee } from "./employee";
import { InputError } from "./store";

type Db = Parameters<typeof migrateRunBoxJobs>[0];

export function resolveJobAccess(db: Db, employee: Employee, projectId: unknown, jobId: unknown) {
  if (typeof projectId !== "string" || !projectId || projectId.length > 256) throw new InputError("Invalid project ID");
  if (typeof jobId !== "string" || !jobId || jobId.length > 64) throw new InputError("Run-box job not found", 404);
  const membership = requireMembership(employee, projectId);
  migrateRunBoxJobs(db);
  const job = getRunBoxJob(db, jobId);
  if (!job || job.project_id !== projectId) throw new InputError("Run-box job not found", 404);
  const owner = membership.role === "owner";
  return { job, meta: null, permissions: { open: true, stop: owner, manage: owner } };
}
