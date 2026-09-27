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
    return Response.json({enabled:codexEnabled(),sessions:codexEnabled()?codexService().list(projectId):[]});
  } catch(error) { return codexFailure(error); }
}
export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request); sameOrigin(request);
    const input = await body(request);
    const membership = requireMembership(employee,input.projectId);
    if(membership.role !== 'owner') throw new InputError('Project owner required to initialize Codex.',403);
    const project = (await getState()).projects.find(p=>p.id===input.projectId);
    const agent = project?.agents.find(a=>a.id===input.agentId);
    if(!project || !agent || agent.client !== 'Codex') throw new InputError('Choose a registered Codex agent in this project.',400);
    return Response.json({session:codexService().initialize({projectId:project.id,agentId:agent.id,createdBy:employee.id,projectName:project.name,repoUrl:project.repo})},{status:202});
  } catch(error) { return codexFailure(error); }
}
