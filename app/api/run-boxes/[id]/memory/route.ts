import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { getRunBoxJob, migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";
import { defaultBackboardFile, projectMemoryStatus, setEnvironmentMemory } from "../../../../../lib/backboard-memory.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const projectId = input.projectId;
    if (typeof projectId !== "string" || !projectId.trim()) throw new InputError("Invalid project ID");
    if (typeof input.enabled !== "boolean") throw new InputError("Shared memory must be on or off");
    const membership = requireMembership(employee, projectId);
    if (membership.role !== "owner") throw new InputError("Project owner required to change shared memory", 403);
    const { id } = await context.params;
    const db = getDatabase();
    migrateRunBoxJobs(db);
    const job = getRunBoxJob(db, id);
    if (!job || job.project_id !== projectId) throw new InputError("Run-box job not found", 404);
    const memory = setEnvironmentMemory(defaultBackboardFile(), id, input.enabled);
    return Response.json({ memory: { ...memory, available: projectMemoryStatus().enabled } });
  } catch (error) {
    return failure(error);
  }
}
