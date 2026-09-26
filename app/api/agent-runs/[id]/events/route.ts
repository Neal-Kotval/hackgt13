import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";
import {
  AgentRunError, MAX_EVENTS_PER_CALL, MAX_TEXT, appendAgentRunEvents, getAgentRunRow, migrateAgentRuns,
} from "../../../../../lib/agent-runs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A full batch (200 events, each with bounded text and command) exceeds the
// shared 32 KiB JSON limit, so this route reads its own bounded body.
const MAX_BODY = MAX_EVENTS_PER_CALL * (MAX_TEXT * 2 + 512) * 2;

async function eventsBody(request: Request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new InputError("Request too large", 413);
  const text = await request.text();
  if (text.length > MAX_BODY) throw new InputError("Request too large", 413);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InputError("Expected a JSON object"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Expected a JSON object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (key !== "events") throw new InputError(`Unsupported field: ${key}`);
  return input;
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const { id } = await context.params;
    if (typeof id !== "string" || !id || id.length > 64) throw new InputError("Run not found", 404);
    const input = await eventsBody(request);
    const db = getDatabase();
    migrateRunBoxJobs(db);
    migrateAgentRuns(db);
    const run = getAgentRunRow(db, id);
    if (!run) throw new InputError("Run not found", 404);
    requireMembership(employee, run.project_id);
    return Response.json(appendAgentRunEvents(db, { runId: id, employeeId: employee.id, events: input.events }));
  } catch (error) {
    return failure(error instanceof AgentRunError ? new InputError(error.message, error.status) : error);
  }
}
