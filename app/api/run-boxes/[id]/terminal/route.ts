import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../../lib/employee";
import { body, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
// TEMPORARY: switch to "../../../../../lib/run-box-access.mjs" when slice A merges.
import { resolveJobAccess } from "../../../../../lib/run-box-access-shim";
import { terminalFailure, webTerminalService } from "../../../../../lib/web-terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Opens a PTY on the environment over SSH (trusted shell access, not a sandbox) and
// returns a session id bound to this employee and job. The browser then attaches with
// GET ./:sessionId/stream and sends keystrokes with POST ./:sessionId/input.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const { id } = await context.params;
    const access = resolveJobAccess(getDatabase(), employee, input.projectId, id);
    if (!access.permissions.open) throw new InputError("You cannot open a terminal on this environment", 403);
    const session = await webTerminalService().open({
      employeeId: employee.id, projectId: String(input.projectId), jobId: id, cols: input.cols, rows: input.rows,
    });
    return Response.json(session, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return terminalFailure(error);
  }
}
