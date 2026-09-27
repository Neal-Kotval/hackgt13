import { requireEmployee, requireMembership } from '@/lib/employee';
import { codexFailure, codexService } from '@/lib/codex-service';
import { listChatRuns } from '@/lib/chat-runs.mjs';
import { body, sameOrigin } from '@/lib/http';
import { InputError } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const projectId = new URL(request.url).searchParams.get('projectId');
    if (!projectId?.trim() || projectId.length > 256) throw new InputError('Choose a project.', 400);
    requireMembership(employee, projectId);
    return Response.json({ runs: listChatRuns(codexService(), projectId) }, {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return codexFailure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    if (typeof input.projectId !== 'string' || !input.projectId.trim() || input.projectId.length > 256)
      throw new InputError('Choose a project.', 400);
    requireMembership(employee, input.projectId);
    if (typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.sessionId.length > 256)
      throw new InputError('Choose a conversation.', 400);
    return Response.json(codexService().setConversationStatus(input.sessionId, {
      projectId: input.projectId, status: input.status,
      actor: { id: employee.id, name: employee.name },
    }), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return codexFailure(error);
  }
}
