import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { forceStopRunBoxJob } from "../../../../../lib/run-box-jobs.mjs";
import { resolveJobAccess } from "../../../../../lib/run-box-access.mjs";

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
    const { id } = await context.params;
    const db = getDatabase();
    // A project owner (or the creator) of a job the caller can see; a private job is
    // 404 to everyone else. Platform admin force close (/admin/aws) is separate.
    const { permissions, membership, creatorId } = resolveJobAccess(db, employee, projectId, id);
    if (!permissions.stop || (membership.role !== "owner" && creatorId !== employee.id))
      throw new InputError("Project owner required to force stop a run box", 403);
    const result = forceStopRunBoxJob(db, id, employee.id);
    if (!result) throw new InputError("Run-box job not found", 404);
    return Response.json(result);
  } catch (error) {
    return failure(error);
  }
}
