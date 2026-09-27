import { requireEmployee, requireMembership } from '@/lib/employee';
import { body, sameOrigin } from '@/lib/http';
import { getState, InputError } from '@/lib/store';
import { codexEnabled, codexFailure, codexService } from '@/lib/codex-service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const projectId = new URL(request.url).searchParams.get('projectId') || '';
    requireMembership(employee, projectId);
    // `enabled` reports local Docker boxes; environment (runBox) sessions are always listed.
    return Response.json({enabled:codexEnabled(),sessions:codexService().list(projectId)});
  } catch(error) { return codexFailure(error); }
}
export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request); sameOrigin(request);
    const input = await body(request);
    const membership = requireMembership(employee,input.projectId);
    if(input.newChat !== undefined && typeof input.newChat !== 'boolean') throw new InputError('Invalid new chat option.',400);
    if(input.newChat !== true && membership.role !== 'owner') throw new InputError('Project owner required to initialize Codex.',403);
    const project = (await getState()).projects.find(p=>p.id===input.projectId);
    const agent = project?.agents.find(a=>a.id===input.agentId);
    if(!project || !agent || agent.client !== 'Codex') throw new InputError('Choose a registered Codex agent in this project.',400);
    const runBoxId = input.runBoxId ?? null;
    if(runBoxId !== null && (typeof runBoxId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(runBoxId))) throw new InputError('Invalid environment.',400);
    if(input.newChat === true && runBoxId === null) throw new InputError('New chats require an environment.',400);
    if(runBoxId === null && !codexEnabled()) throw new InputError('Local Codex boxes are disabled on this server.',503);
    return Response.json({session:codexService().initialize({projectId:project.id,agentId:agent.id,createdBy:employee.id,projectName:project.name,repoUrl:project.repo,runBoxId,newChat:input.newChat===true,requestId:typeof input.requestId === "string" ? input.requestId : undefined})},{status:202});
  } catch(error) { return codexFailure(error); }
}
