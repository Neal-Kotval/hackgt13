import { getDatabase } from "../../../../../lib/auth.mjs";
import { mailDeliveryStatus } from "../../../../../lib/mail.mjs";
import { findMachine, machines } from "../../../../../lib/machine-catalog.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../../lib/http";
import { getState, InputError, updateProjectSettings } from "../../../../../lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };
type MemberRow = { userId: string; name: string; email: string; orgRole: string; projectRole: string | null };

function settings(project: { id: string; name: string; repo: string; environmentDefaults?: { machineId: string | null; visibility: "private" | "public"; sharedMemory?: boolean } }) {
  return {
    id: project.id,
    name: project.name,
    repo: project.repo,
    // Projects saved before defaults existed get the same private default new environments use.
    environmentDefaults: { machineId: null, visibility: "private", sharedMemory: false, ...project.environmentDefaults },
  };
}

/** Project settings: general fields, environment defaults, and people with access. Members read; owners write. */
export async function GET(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    const { id } = await context.params;
    const membership = requireMembership(employee, id);
    const project = (await getState()).projects.find((item) => item.id === id);
    if (!project) throw new InputError("Project not found", 404);
    const db = getDatabase();
    const organization = employee.activeOrganization!;
    const manageOrganization = ["owner", "admin"].includes(organization.role);
    const rows = db.prepare(`SELECT m.userId, u.name, u.email, m.role AS orgRole, pm.role AS projectRole
      FROM project_organization po JOIN member m ON m.organizationId = po.organization_id
      JOIN user u ON u.id = m.userId
      LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
      WHERE po.project_id = ? ORDER BY u.name`).all(id) as MemberRow[];
    const members = rows
      .filter((row) => ["owner", "admin"].includes(row.orgRole) || row.projectRole)
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        organizationRole: row.orgRole,
        role: ["owner", "admin"].includes(row.orgRole) ? "owner" : row.projectRole,
        // Organization owners and admins reach every project; their access is not removable here.
        implicit: ["owner", "admin"].includes(row.orgRole),
      }));
    const candidates = manageOrganization
      ? rows.filter((row) => row.orgRole === "member" && !row.projectRole).map(({ userId, name, email }) => ({ userId, name, email }))
      : [];
    const invitations = manageOrganization
      ? db.prepare(`SELECT i.id, i.email, i.role, i.status, i.expiresAt, d.status AS delivery FROM invitation i
          LEFT JOIN invitation_delivery d ON d.invitation_id = i.id
          WHERE i.organizationId = ? AND i.status = 'pending' ORDER BY i.createdAt DESC`).all(organization.id)
      : [];
    return Response.json({
      project: settings(project),
      viewer: { id: employee.id, projectRole: membership.role, organizationRole: organization.role },
      organization: { id: organization.id, name: organization.name },
      permissions: { edit: membership.role === "owner", invite: manageOrganization },
      members,
      candidates,
      invitations,
      mailMode: mailDeliveryStatus(),
      machines: machines.map(({ id, kind, size, instanceType, vcpu, memoryGib, gpu, hourlyComputeUsd }) => ({ id, kind, size, instanceType, vcpu, memoryGib, gpu, hourlyComputeUsd })),
    });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const { id } = await context.params;
    const membership = requireMembership(employee, id);
    if (membership.role !== "owner") throw new InputError("Only project owners can change project settings", 403);
    const input = await body(request);
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "repo", "environmentDefaults"]) if (input[key] !== undefined) patch[key] = input[key];
    if (!Object.keys(patch).length) throw new InputError("Nothing to update");
    const defaults = patch.environmentDefaults as { machineId?: unknown } | undefined;
    if (defaults && typeof defaults === "object" && defaults.machineId != null && !findMachine(defaults.machineId))
      throw new InputError("Choose a machine size from the catalog");
    const project = await updateProjectSettings(id, patch, employee.name || employee.email);
    return Response.json({ project: settings(project) });
  } catch (error) {
    return failure(error);
  }
}
