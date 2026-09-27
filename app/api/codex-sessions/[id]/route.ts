import { requireEmployee, requireMembership } from '@/lib/employee';
import { body, sameOrigin } from '@/lib/http';
import { InputError } from '@/lib/store';
import { codexFailure, codexService } from '@/lib/codex-service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = {params:Promise<{id:string}>};
export async function GET(request:Request,context:Context) {
  try {
    const employee = await requireEmployee(request);
    const {id} = await context.params;
    const service = codexService(), session = service.get(id);
    requireMembership(employee,session.projectId);
    return Response.json(service.snapshot(id),{headers:{'cache-control':'no-store'}});
  } catch(error) {return codexFailure(error);}
}
export async function POST(request:Request,context:Context) {
  try {
    const employee = await requireEmployee(request); sameOrigin(request);
    const {id} = await context.params;
    const service = codexService(), session = service.get(id);
    const membership = requireMembership(employee,session.projectId);
    const input = await body(request);
    if(!['message','interrupt'].includes(String(input.action)) && membership.role!=='owner')throw new InputError('Project owner required for Codex setup and lifecycle controls.',403);
    return Response.json(await service.action(id,{...input,actor:{id:employee.id,name:employee.name}}));
  } catch(error) {return codexFailure(error);}
}
