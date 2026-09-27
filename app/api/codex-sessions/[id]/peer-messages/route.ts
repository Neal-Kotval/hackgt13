import { requireEmployee, requireMembership } from '@/lib/employee';
import { body, sameOrigin } from '@/lib/http';
import { InputError } from '@/lib/store';
import { codexFailure, codexService } from '@/lib/codex-service';
import { getDatabase } from '@/lib/auth.mjs';
import { requireSessionVisible } from '@/lib/run-box-access.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    const { id } = await context.params;
    const service = codexService(), session = service.get(id);
    requireMembership(employee, session.projectId);
    requireSessionVisible(getDatabase(), employee, session);
    const query = new URL(request.url).searchParams;
    const messageId = query.get('messageId');
    const view = query.get('view');
    if (view !== null && view !== 'history')throw new InputError('Invalid message view',400);
    if (view === 'history') {
      if (messageId)throw new InputError('Choose a message or history',400);
      return Response.json(service.peerMessageHistory(id,{
        ...(query.has('limit')?{limit:Number(query.get('limit'))}:{}),
        ...(query.has('beforeSequence')?{beforeSequence:Number(query.get('beforeSequence'))}:{})
      }),{headers:{'cache-control':'no-store'}});
    }
    return Response.json(messageId ? {message:service.peerMessage(id,messageId)} : {messages:service.pendingPeerMessages(id)},
      { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return codexFailure(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const { id } = await context.params;
    const service = codexService(), session = service.get(id);
    requireMembership(employee, session.projectId);
    // Peers must share the sender's box, so the sender's visibility covers the recipient.
    requireSessionVisible(getDatabase(), employee, session);
    const input = await body(request);
    if (input.broadcast !== undefined && input.broadcast !== true) throw new InputError('Invalid broadcast option.',400);
    if (input.audience !== undefined && (input.broadcast !== true || (input.audience !== 'agents' && input.audience !== 'conversations')))
      throw new InputError('Invalid broadcast audience',400);
    if (input.broadcast === true) {
      if (input.toSessionId !== undefined) throw new InputError('Choose a recipient or broadcast, not both.',400);
      const messages = service.broadcastPeerMessage(id, {
        text: input.text, requestId: input.requestId, audience: typeof input.audience === 'string' ? input.audience : undefined,
        actor: {id:employee.id,name:employee.name},
      });
      return Response.json({ messages }, { status: 202 });
    }
    const message = service.sendPeerMessage(id, {
      toSessionId: input.toSessionId,
      text: input.text,
      requestId: input.requestId,
      actor: {id:employee.id,name:employee.name},
    });
    return Response.json({ message }, { status: 202 });
  } catch (error) { return codexFailure(error); }
}
