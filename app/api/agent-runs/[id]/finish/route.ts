import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";
import { AgentRunError, finishAgentRun, getAgentRunRow, migrateAgentRuns } from "../../../../../lib/agent-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const { id } = await context.params;
    if (typeof id !== "string" || !id || id.length > 64) throw new InputError("Run not found", 404);
    const input = await body(request);
    for (const key of Object.keys(input))
      if (!["status", "exitCode"].includes(key)) throw new InputError(`Unsupported field: ${key}`);
    const db = getDatabase();
    migrateRunBoxJobs(db);
    migrateAgentRuns(db);
    const run = getAgentRunRow(db, id);
    if (!run) throw new InputError("Run not found", 404);
    requireMembership(employee, run.project_id);
    const finished = finishAgentRun(db, { runId: id, employeeId: employee.id, status: input.status, exitCode: input.exitCode });
    return Response.json({ run: finished });
  } catch (error) {
    return failure(error instanceof AgentRunError ? new InputError(error.message, error.status) : error);
  }
}
