import { body, sameOrigin } from "../../../../../../../lib/http";
import { authorizeSession, terminalFailure } from "../../../../../../../lib/web-terminal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string; sessionId: string }> }) {
  try {
    const { id, sessionId } = await context.params;
    sameOrigin(request);
    const { employee, service } = await authorizeSession(request, id, sessionId);
    const input = await body(request);
    service.resize(sessionId, employee.id, id, input.cols, input.rows);
    return new Response(null, { status: 204 });
  } catch (error) {
    return terminalFailure(error);
  }
}
