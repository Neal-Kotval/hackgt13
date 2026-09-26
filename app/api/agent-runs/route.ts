import { getDatabase } from "../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../lib/employee";
import { body, failure, sameOrigin } from "../../../lib/http";
import { InputError } from "../../../lib/store";
import { getRunBoxJob, migrateRunBoxJobs } from "../../../lib/run-box-jobs.mjs";
import { AgentRunError, createAgentRun, listAgentRuns, migrateAgentRuns } from "../../../lib/agent-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new InputError(`Invalid ${name}`);
  return value;
}

function database() {
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateAgentRuns(db);
  return db;
}

function fail(error: unknown) {
  return failure(error instanceof AgentRunError ? new InputError(error.message, error.status) : error);
}

// Start a run record for an agent in a ready environment the caller can access.
export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    for (const key of Object.keys(input))
      if (!["runBoxId", "agent", "prompt"].includes(key)) throw new InputError(`Unsupported field: ${key}`);
    const runBoxId = identifier(input.runBoxId, "run box ID");
    const db = database();
    const runBox = getRunBoxJob(db, runBoxId);
    if (!runBox) throw new InputError("Environment not found", 404);
    requireMembership(employee, runBox.project_id);
    const run = createAgentRun(db, { runBox, employeeId: employee.id, agent: input.agent, prompt: input.prompt });
    return Response.json({ run }, { status: 201 });
  } catch (error) {
    return fail(error);
  }
}

export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const projectId = identifier(new URL(request.url).searchParams.get("projectId"), "project ID");
    requireMembership(employee, projectId);
    return Response.json({ runs: listAgentRuns(database(), projectId) });
  } catch (error) {
    return fail(error);
  }
}
