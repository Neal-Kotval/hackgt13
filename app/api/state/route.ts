import { action, getState, InputError } from "../../../lib/store";
import { body, failure, sameOrigin } from "../../../lib/http";
import {
  requireEmployee,
  requireMembership,
  requireOrganizationAdmin,
  employeeState,
} from "../../../lib/employee";
import { grantMembership, attachProject } from "../../../lib/auth.mjs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    return Response.json(employeeState(await getState(), employee));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    if (input.type === "createProject") requireOrganizationAdmin(employee);
    if (input.type !== "createProject") {
      const membership = requireMembership(employee, input.projectId);
      if (
        (input.type === "rotateAgentToken" || input.type === "revokeAgentToken") &&
        membership.role !== "owner"
      ) throw new InputError("Project owner required", 403);
    }
    const result = await action(input);
    if (
      input.type === "createProject" &&
      "id" in result &&
      typeof result.id === "string"
    ) {
      attachProject(result.id, employee.activeOrganization!.id);
      grantMembership(employee.id, result.id, "owner");
      employee.memberships.push({ projectId: result.id, role: "owner" });
    }
    return Response.json({
      ...result,
      state: employeeState(result.state, employee),
    });
  } catch (error) {
    return failure(error);
  }
}
