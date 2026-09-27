import { getDatabase } from "../../../../lib/auth.mjs";
import { requireEmployee } from "../../../../lib/employee";
import { body, failure, sameOrigin } from "../../../../lib/http";
import { InputError } from "../../../../lib/store";
import { listAwsApprovals, setAwsApproval } from "../../../../lib/aws-organization-approval.mjs";
import { migrateRunBoxJobs } from "../../../../lib/run-box-jobs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function platformAdmin(request: Request) {
  const employee = await requireEmployee(request);
  const configured = process.env.AGENTCLOUD_PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  if (!configured || employee.email.toLowerCase() !== configured)
    throw new InputError("Platform operator access required", 403);
  return employee;
}

export async function GET(request: Request) {
  try {
    await platformAdmin(request);
    migrateRunBoxJobs(getDatabase());
    return Response.json({ organizations: listAwsApprovals(getDatabase()) });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const admin = await platformAdmin(request);
    sameOrigin(request);
    const input = await body(request);
    if (Object.keys(input).some((key) => !["organizationId", "approved", "maxRunMinutes", "monthlyMinutes"].includes(key)))
      throw new InputError("Unsupported approval field");
    if (typeof input.organizationId !== "string" || !input.organizationId ||
        typeof input.approved !== "boolean" || ![60, 120].includes(input.maxRunMinutes as number) ||
        !Number.isInteger(input.monthlyMinutes) || (input.monthlyMinutes as number) < 60 ||
        (input.monthlyMinutes as number) > 1200 || (input.monthlyMinutes as number) % 60 !== 0)
      throw new InputError("Invalid AWS approval limits");
    try {
      const approval = setAwsApproval(getDatabase(), {
        organizationId: input.organizationId,
        approved: input.approved,
        maxRunMinutes: input.maxRunMinutes,
        monthlyMinutes: input.monthlyMinutes,
        actorId: admin.id,
      });
      return Response.json({ approval });
    } catch (error) {
      if (error instanceof Error && error.message === "Organization not found")
        throw new InputError(error.message, 404);
      throw error;
    }
  } catch (error) { return failure(error); }
}
