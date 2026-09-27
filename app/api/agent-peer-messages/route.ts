import { authenticateAgentToken, InputError } from '@/lib/store';
import { body } from '@/lib/http';
import { codexFailure, codexService } from '@/lib/codex-service';

export const runtime = 'nodejs';
export async function GET(request: Request) {
  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw new InputError('Bearer token required', 401);
    const identity = await authenticateAgentToken(authorization.slice(7));
    const query = new URL(request.url).searchParams;
    const service = codexService();
    const source = service.get(query.get('fromSessionId') || '');
    if (source.projectId !== identity.projectId || source.agentId !== identity.agentId)
      throw new InputError('Token cannot read for another project or agent', 403);
    return Response.json({message:service.peerMessage(source.id,query.get('messageId') || '')},
      {headers:{'cache-control':'no-store'}});
  } catch (error) { return codexFailure(error); }
}
export async function POST(request: Request) {
  try {
    const authorization = request.headers.get('authorization');
    if (!authorization?.startsWith('Bearer ')) throw new InputError('Bearer token required', 401);
    const identity = await authenticateAgentToken(authorization.slice(7));
    const input = await body(request);
    if (input.projectId !== identity.projectId || input.agentId !== identity.agentId)
      throw new InputError('Token cannot access another identity or project', 403);
    const service = codexService();
    const source = service.get(String(input.fromSessionId || ''));
    if (source.projectId !== identity.projectId || source.agentId !== identity.agentId)
      throw new InputError('Token cannot send for another project or agent', 403);
    if (input.broadcast !== undefined && input.broadcast !== true)
      throw new InputError('Invalid broadcast option', 400);
    if (input.audience !== undefined && (input.broadcast !== true || (input.audience !== 'agents' && input.audience !== 'conversations')))
      throw new InputError('Invalid broadcast audience',400);
    if (input.broadcast === true) {
      if (input.toSessionId !== undefined) throw new InputError('Choose a recipient or broadcast, not both', 400);
      const messages = service.broadcastPeerMessage(source.id, {
        text: input.text, requestId: input.requestId, audience: typeof input.audience === 'string' ? input.audience : undefined,
        actor: {id:identity.agentId,name:'Connected agent'},
      });
      return Response.json({ messages }, { status: 202 });
    }
    const message = service.sendPeerMessage(source.id, {
      toSessionId: input.toSessionId,
      text: input.text,
      requestId: input.requestId,
      actor: {id:identity.agentId,name:'Connected agent'},
    });
    return Response.json({ message }, { status: 202 });
  } catch (error) { return codexFailure(error); }
}
