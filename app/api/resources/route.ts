import {
  requireEmployee,
  requireMembership,
  employeeState,
} from "../../../lib/employee";
import { resourceAction } from "../../../lib/store";
import { body, failure, sameOrigin } from "../../../lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const membership = requireMembership(employee, input.projectId);
    const result = await resourceAction(input, {
      employeeId: employee.id,
      organizationId: employee.activeOrganization!.id,
      projectRole: membership.role,
    });
    return Response.json({
      ...result,
      state: employeeState(result.state, employee),
    });
  } catch (error) {
    return failure(error);
  }
}
