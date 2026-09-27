import { getDatabase } from "./auth.mjs";
import { createWebTerminalService, WebTerminalError } from "./web-terminal.mjs";
import { failure } from "./http";
import { requireEmployee } from "./employee";
// TEMPORARY: switch to "./run-box-access.mjs" when slice A merges (see run-box-access-shim.ts).
import { resolveJobAccess } from "./run-box-access-shim";
import { InputError } from "./store";

// One bridge per server process. Sessions live in memory, so the stream and the input
// POSTs for a session must reach the same Node process (true for the single staging
// instance and for local `next dev` / `next start`).
const shared = globalThis as typeof globalThis & { agentcloudWebTerminal?: ReturnType<typeof createWebTerminalService> };
export function webTerminalService() {
  return shared.agentcloudWebTerminal ??= createWebTerminalService({ db: getDatabase() });
}

export function terminalFailure(error: unknown) {
  if (error instanceof WebTerminalError)
    return Response.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
  if (error instanceof InputError) return failure(error);
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
