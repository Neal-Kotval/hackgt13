import { getAuth, memberships, organizations } from "./auth.mjs";
import { InputError } from "./store";

export async function requireEmployee(request: Request) {
  // Only a verified session cookie establishes employee identity. Agent bearer
  // credentials and client-provided IDs never participate in this lookup.
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) throw new InputError("Employee sign-in required", 401);
  if (!session.user.emailVerified) throw new InputError("Verify your email first", 403);
  const available = organizations(session.user.id) as { id: string; name: string; slug: string; role: string }[];
  const active = available.find((org) => org.id === session.session.activeOrganizationId) || null;
  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    organizations: available,
    activeOrganization: active,
    memberships: (active ? memberships(session.user.id, active.id) : []) as {
      projectId: string;
      role: "owner" | "member";
    }[],
  };
}
export type Employee = Awaited<ReturnType<typeof requireEmployee>>;
export function requireMembership(employee: Employee, projectId: unknown) {
  const membership = employee.memberships.find(
    (item) => item.projectId === projectId,
  );
  if (!membership)
    throw new InputError("Project membership required", 403);
  return membership;
}
export function employeeState<T extends { projects: { id: string }[] }>(
  state: T,
  employee: Employee,
): T {
  return {
    ...state,
    projects: state.projects.filter((project) =>
      employee.memberships.some((m) => m.projectId === project.id),
    ),
  };
}

export function requireOrganizationAdmin(employee: Employee) {
  if (!employee.activeOrganization || !["owner", "admin"].includes(employee.activeOrganization.role))
    throw new InputError("Organization owner or admin required", 403);
  return employee.activeOrganization;
}
