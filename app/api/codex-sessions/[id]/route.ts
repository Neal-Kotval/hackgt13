import { requireEmployee, requireMembership } from '@/lib/employee';
import { body, sameOrigin } from '@/lib/http';
import { InputError } from '@/lib/store';
import { codexFailure, codexService } from '@/lib/codex-service';
import { getDatabase } from '@/lib/auth.mjs';
import { requireSessionVisible } from '@/lib/run-box-access.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params:Promise<{id:string}>};
export async function GET(request:Request,context:Context) {
  try {
    const employee = await requireEmployee(request);
    const {id} = await context.params;
    const service = codexService(), session = service.get(id);
    requireMembership(employee,session.projectId);
    requireSessionVisible(getDatabase(),employee,session);
    return Response.json(service.snapshot(id),{headers:{'cache-control':'no-store'}});
  } catch(error) {return codexFailure(error);}
}
export async function POST(request:Request,context:Context) {
  try {
    const employee = await requireEmployee(request); sameOrigin(request);
    const {id} = await context.params;
    const service = codexService(), session = service.get(id);
    const membership = requireMembership(employee,session.projectId);
    requireSessionVisible(getDatabase(),employee,session);
    const input = await body(request);
    const memberReconnect=input.action==='resume' && session.target.kind==='runBox' && session.isSetupSession===false;
    if(!['message','interrupt'].includes(String(input.action)) && !memberReconnect && membership.role!=='owner')throw new InputError('Project owner required for Codex setup and lifecycle controls.',403);
    return Response.json(await service.action(id,{...input,actor:{id:employee.id,name:employee.name}}));
  } catch(error) {return codexFailure(error);}
}

export async function DELETE(request:Request,context:Context) {
  try {
    const employee = await requireEmployee(request); sameOrigin(request);
    const {id} = await context.params;
    const service = codexService(), session = service.get(id);
    const membership = requireMembership(employee,session.projectId);
    requireSessionVisible(getDatabase(),employee,session);
    if(session.createdBy!==employee.id && membership.role!=='owner')
      throw new InputError('Only the chat creator or a project owner can delete this chat.',403);
    return Response.json(await service.delete(id));
  } catch(error) {return codexFailure(error);}
}

export async function PATCH(request:Request,context:Context) {
  try {
    const employee = await requireEmployee(request); sameOrigin(request);
    const {id} = await context.params;
    const service = codexService(), session = service.get(id);
    const membership = requireMembership(employee,session.projectId);
    requireSessionVisible(getDatabase(),employee,session);
    if(session.createdBy!==employee.id && membership.role!=='owner')
      throw new InputError('Only the chat creator or a project owner can rename this chat.',403);
    const input = await body(request);
    return Response.json(service.rename(id,input.title));
  } catch(error) {return codexFailure(error);}
}
