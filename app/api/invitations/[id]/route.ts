import { getDatabase } from "../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../lib/employee";
import { failure } from "../../../../lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    const { id } = await params;
    const invite = getDatabase().prepare('SELECT i.email, i.role, i.status, i.expiresAt, i.organizationId, o.name AS organizationName FROM invitation i JOIN organization o ON o.id=i.organizationId WHERE i.id=?').get(id) as { email: string; role: string; status: string; expiresAt: string | number; organizationId: string; organizationName: string } | undefined;
    if (!invite) return Response.json({ error: "Invitation unavailable. Ask an administrator for a new invitation." }, {status:404});
    if (invite.email.toLowerCase() !== employee.email.toLowerCase()) return Response.json({error:"This invitation is for a different email. Switch accounts to continue."},{status:403});
    const status = invite.status === "pending" && new Date(invite.expiresAt).getTime() < Date.now() ? "expired" : invite.status;
    const member = employee.organizations.some(org => org.id === invite.organizationId);
    return Response.json({ organizationName: invite.organizationName, organizationId: invite.organizationId, role: invite.role, status, member });
  } catch(error) {return failure(error);}
}
