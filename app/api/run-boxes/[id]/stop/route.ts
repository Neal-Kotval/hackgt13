import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { requestRunBoxStop } from "../../../../../lib/run-box-jobs.mjs";
import { resolveJobAccess } from "../../../../../lib/run-box-access.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const projectId = input.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) throw new InputError("Invalid project ID");
    const { id } = await context.params;
    // Environment model: any member may stop a public job; only its creator a private one.
    const { permissions } = resolveJobAccess(getDatabase(), employee, projectId, id);
    if (!permissions.stop) throw new InputError("You cannot stop this environment", 403);
    return Response.json({ job: requestRunBoxStop(getDatabase(), id, employee.id) });
  } catch (error) {
    return failure(error);
  }
}
