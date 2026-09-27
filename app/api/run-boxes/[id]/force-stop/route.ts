import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { forceStopRunBoxJob, getRunBoxJob, migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HAC-168: owner-only force stop for a job that blocks new environments. It closes a
// job at once only when nothing was ever launched; otherwise it requests termination
// through the normal stop path, and the job stays blocking until the provider confirms.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const projectId = input.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) throw new InputError("Invalid project ID");
    const membership = requireMembership(employee, projectId);
    if (membership.role !== "owner") throw new InputError("Project owner required to force stop a run box", 403);
    const { id } = await context.params;
    const db = getDatabase();
    migrateRunBoxJobs(db);
    const job = getRunBoxJob(db, id);
    if (!job || job.project_id !== projectId) throw new InputError("Run-box job not found", 404);
    const result = forceStopRunBoxJob(db, id, employee.id);
    if (!result) throw new InputError("Run-box job not found", 404);
    return Response.json(result);
  } catch (error) {
    return failure(error);
  }
}
