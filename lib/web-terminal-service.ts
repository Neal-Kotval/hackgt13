import { getDatabase, memberships } from "./auth.mjs";
import { createWebTerminalService, WebTerminalError } from "./web-terminal.mjs";
import { exposedError, failure } from "./http";
import { requireEmployee, type Employee } from "./employee";
import { resolveJobAccess } from "./run-box-access.mjs";
import { InputError } from "./store";

// One bridge per server process. Sessions live in memory, so the stream and the input
// POSTs for a session must reach the same Node process (true for the single staging
// instance and for local `next dev` / `next start`).
const shared = globalThis as typeof globalThis & { agentcloudWebTerminal?: ReturnType<typeof createWebTerminalService> };
export function webTerminalService() {
  return shared.agentcloudWebTerminal ??= (() => {
    const db = getDatabase();
    return createWebTerminalService({
      db,
      // Periodic re-check without a request: the employee's current project memberships
      // and the job's visibility, through the same policy as every route.
      stillAllowed: ({ employeeId, projectId, jobId }) => {
        const current = (memberships(employeeId) as Employee["memberships"]).filter((item) => item.projectId === projectId);
        if (!current.length) return false;
        const employee = { id: employeeId, memberships: current } as Employee;
        return resolveJobAccess(db, employee, projectId, jobId).permissions.open === true;
      },
    });
  })();
}

export function terminalFailure(error: unknown) {
  if (error instanceof WebTerminalError)
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  if (error instanceof InputError || exposedError(error)) return failure(error);
  // Never echo or log raw SSH errors: they can carry provider text.
  return Response.json({ error: "Terminal operation failed." }, { status: 500 });
}

// Every session request re-checks the caller's access to the job, so a revoked
// membership or a job that turned private ends the session on its next request.
export async function authorizeSession(request: Request, jobId: string, sessionId: string) {
  const employee = await requireEmployee(request);
  const service = webTerminalService();
  const { projectId } = service.session(sessionId, employee.id, jobId);
  try {
    const access = resolveJobAccess(getDatabase(), employee, projectId, jobId);
    if (!access.permissions.open) throw new InputError("You cannot open a terminal on this environment", 403);
  } catch (error) {
    try { service.close(sessionId, employee.id, jobId, "access_revoked"); } catch { /* Already closed. */ }
    throw error;
  }
  return { employee, service };
}
