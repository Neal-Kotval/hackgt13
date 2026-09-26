import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { getRunBoxJob, migrateRunBoxJobs, requestRunBoxStop } from "../../../../../lib/run-box-jobs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const projectId = input.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) throw new InputError("Invalid project ID");
    const membership = requireMembership(employee, projectId);
    if (membership.role !== "owner") throw new InputError("Project owner required to stop a run box", 403);
    const { id } = await context.params;
    migrateRunBoxJobs(getDatabase());
    const job = getRunBoxJob(getDatabase(), id);
    if (!job || job.project_id !== projectId) throw new InputError("Run-box job not found", 404);
    return Response.json({ job: requestRunBoxStop(getDatabase(), id, employee.id) });
  } catch (error) {
    return failure(error);
  }
}
