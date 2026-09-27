import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { resolveJobAccess } from "../../../../../lib/run-box-access.mjs";
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
    const { id } = await context.params;
    // Environment model: the creator, or a project owner for a public job; a private
    // job is 404 to everyone else.
    const { permissions } = resolveJobAccess(getDatabase(), employee, projectId, id);
    if (!permissions.manage)
      throw new InputError("Only the environment's creator or a project owner can change shared memory", 403);
    const memory = setEnvironmentMemory(defaultBackboardFile(), id, input.enabled);
    return Response.json({ memory: { ...memory, available: projectMemoryStatus().enabled } });
  } catch (error) {
    return failure(error);
  }
}
