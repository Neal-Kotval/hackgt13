import { getDatabase } from "../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../lib/employee";
import { failure } from "../../../../lib/http";
import { InputError } from "../../../../lib/store";
import { migrateRunBoxJobs } from "../../../../lib/run-box-jobs.mjs";
import { AgentRunError, getAgentRun, migrateAgentRuns } from "../../../../lib/agent-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A run and its reported events ordered by seq. `?afterSeq=` returns only newer events.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    const { id } = await context.params;
    if (typeof id !== "string" || !id || id.length > 64) throw new InputError("Run not found", 404);
    const raw = new URL(request.url).searchParams.get("afterSeq");
    const afterSeq = raw === null ? -1 : Number(raw);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < -1) throw new InputError("Invalid afterSeq");
    const db = getDatabase();
    migrateRunBoxJobs(db);
    migrateAgentRuns(db);
    const result = getAgentRun(db, id, { afterSeq });
    if (!result) throw new InputError("Run not found", 404);
    requireMembership(employee, result.run.projectId);
    return Response.json(result);
  } catch (error) {
    return failure(error instanceof AgentRunError ? new InputError(error.message, error.status) : error);
  }
}
