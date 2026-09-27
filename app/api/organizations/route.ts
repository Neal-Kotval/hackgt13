import { getDatabase } from "../../../lib/auth.mjs";
import { mailDeliveryStatus } from "../../../lib/mail.mjs";
import { requireEmployee, requireOrganizationAdmin, employeeState } from "../../../lib/employee";
import { getState, InputError } from "../../../lib/store";
import { body, failure, sameOrigin } from "../../../lib/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const db = getDatabase();
    const active = employee.activeOrganization;
    const manage = active && ["owner", "admin"].includes(active.role);
    const members = active ? db.prepare('SELECT m.id, m.userId, m.role, u.name, u.email FROM member m JOIN user u ON u.id=m.userId WHERE m.organizationId=? ORDER BY u.name').all(active.id) : [];
    const invitations = manage ? db.prepare("SELECT i.id, i.email, i.role, i.status, i.expiresAt, d.status AS delivery FROM invitation i LEFT JOIN invitation_delivery d ON d.invitation_id=i.id WHERE i.organizationId=? ORDER BY i.createdAt DESC").all(active.id) : [];
    const state = await getState();
    const projects = employeeState(state, employee).projects.map(({ id, name }) => ({ id, name }));
    const legacyIds = db.prepare("SELECT pm.project_id AS id FROM project_membership pm LEFT JOIN project_organization po ON po.project_id=pm.project_id WHERE pm.user_id=? AND pm.role='owner' AND po.project_id IS NULL").all(employee.id) as { id: string }[];
    const legacyProjects = state.projects.filter((p) => legacyIds.some((l) => l.id === p.id)).map(({ id, name }) => ({ id, name }));
    const assignments = manage ? db.prepare("SELECT pm.user_id AS userId, pm.project_id AS projectId FROM project_membership pm JOIN project_organization po ON po.project_id=pm.project_id WHERE po.organization_id=?").all(active.id) : [];
    return Response.json({ ...employee, members, invitations, projects, legacyProjects, assignments, mailMode: mailDeliveryStatus() });
  } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const org = requireOrganizationAdmin(employee);
    const input = await body(request);
    const db = getDatabase();
    if (typeof input.projectId !== "string") throw new InputError("Project required");
    if (input.type === "adoptProject") {
      const legacy = db.prepare("SELECT role FROM project_membership WHERE user_id=? AND project_id=?").get(employee.id, input.projectId) as { role: string } | undefined;
      if (legacy?.role !== "owner") throw new InputError("Existing project owner required", 403);
      if (!(await getState()).projects.some((p) => p.id === input.projectId)) throw new InputError("Project not found", 404);
      db.transaction(() => {
        const legacy = db.prepare("SELECT role FROM project_membership WHERE user_id=? AND project_id=?").get(employee.id, input.projectId) as { role: string } | undefined;
        if (legacy?.role !== "owner") throw new InputError("Existing project owner required", 403);
        if (db.prepare("SELECT 1 FROM project_organization WHERE project_id=?").get(input.projectId)) throw new InputError("Project already belongs to an organization", 409);
        db.prepare("INSERT INTO project_organization (project_id, organization_id) VALUES (?, ?)").run(input.projectId, org.id);
        db.prepare("DELETE FROM project_membership WHERE project_id=? AND user_id<>?").run(input.projectId, employee.id);
      })();
    } else if (input.type === "setProjectAccess") {
      if (typeof input.userId !== "string" || typeof input.allowed !== "boolean") throw new InputError("Member and access required");
      if (!db.prepare("SELECT 1 FROM project_organization WHERE project_id=? AND organization_id=?").get(input.projectId, org.id)) throw new InputError("Project not in organization", 403);
      const target = db.prepare("SELECT role FROM member WHERE userId=? AND organizationId=?").get(input.userId, org.id) as { role: string } | undefined;
      if (!target) throw new InputError("Organization member required", 403);
      if (target.role !== "member") throw new InputError("Owners and admins manage every project");
      if (input.allowed) db.prepare("INSERT INTO project_membership (user_id,project_id,role) VALUES (?,?,'member') ON CONFLICT(user_id,project_id) DO UPDATE SET role='member'").run(input.userId, input.projectId);
      else db.prepare("DELETE FROM project_membership WHERE user_id=? AND project_id=?").run(input.userId, input.projectId);
    } else throw new InputError("Unknown organization action");
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}
