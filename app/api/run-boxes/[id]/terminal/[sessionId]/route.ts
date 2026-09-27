import { sameOrigin } from "../../../../../../lib/http";
import { authorizeSession, terminalFailure } from "../../../../../../lib/web-terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Closes the caller's terminal session.
export async function DELETE(request: Request, context: { params: Promise<{ id: string; sessionId: string }> }) {
  try {
    const { id, sessionId } = await context.params;
    sameOrigin(request);
    const { employee, service } = await authorizeSession(request, id, sessionId);
    service.close(sessionId, employee.id, id, "client_closed");
    return Response.json({ ok: true });
  } catch (error) {
    return terminalFailure(error);
  }
}
