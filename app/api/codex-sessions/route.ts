import { requireEmployee, requireMembership } from '@/lib/employee';
import { body, sameOrigin } from '@/lib/http';
import { createManagedCodexPeer, ensureManagedCodexAgent, getState, InputError } from '@/lib/store';
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
    if(input.newAgent !== undefined && typeof input.newAgent !== 'boolean') throw new InputError('Invalid new agent option.',400);
    if(input.newAgent === true && input.newChat === true) throw new InputError('Create the agent before starting a chat.',400);
    if(input.newAgent === true && input.agentId !== undefined) throw new InputError('A new agent cannot use an existing agent ID.',400);
    if(input.newChat !== true && membership.role !== 'owner') throw new InputError('Project owner required to initialize Codex.',403);
    const project = (await getState()).projects.find(p=>p.id===input.projectId);
    if(!project) throw new InputError('Project not found.',404);
    const runBoxId = input.runBoxId ?? null;
    if(runBoxId !== null && (typeof runBoxId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(runBoxId))) throw new InputError('Invalid environment.',400);
    if(input.newChat === true && runBoxId === null) throw new InputError('New chats require an environment.',400);
    if(runBoxId === null && !codexEnabled()) throw new InputError('Local Codex boxes are disabled on this server.',503);
    const service = codexService();
    let agent = project.agents.find(a=>a.id===input.agentId);
    if(input.newAgent === true) {
      if(!runBoxId) throw new InputError('Choose a ready environment to add an agent.',400);
      service.validateEnvironment(project.id,runBoxId);
      if(!service.list(project.id).some((session: {status:string;target:{kind:string;runBoxId?:string}}) =>
        session.target.kind==='runBox' && session.target.runBoxId===runBoxId && ['ready','running'].includes(session.status)))
        throw new InputError('Finish signing in to Codex on this environment first.',409);
      agent = await createManagedCodexPeer(project.id,String(input.requestId || ''));
    } else if(input.agentId === undefined && input.newChat !== true) {
      if(!runBoxId) throw new InputError('Choose a ready environment to add Codex.',400);
      // Do not persist an identity until the existing execution boundary is validated.
      service.validateEnvironment(project.id,runBoxId);
      const canonical = service.list(project.id).find((session: {agentId:string;isSetupSession:boolean;target:{kind:string;runBoxId?:string}})=>session.isSetupSession && session.target.kind==='runBox' && session.target.runBoxId===runBoxId);
      agent = await ensureManagedCodexAgent(project.id,canonical?.agentId);
    }
    if(!agent || agent.client !== 'Codex') throw new InputError('Choose a registered Codex agent in this project.',400);
    return Response.json({session:service.initialize({projectId:project.id,agentId:agent.id,createdBy:employee.id,projectName:project.name,repoUrl:project.repo,runBoxId,newChat:input.newChat===true,requestId:typeof input.requestId === "string" ? input.requestId : undefined})},{status:202});
  } catch(error) { return codexFailure(error); }
}
