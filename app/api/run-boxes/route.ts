import { getDatabase } from "../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../lib/employee";
import { body, failure, sameOrigin } from "../../../lib/http";
import { InputError, getState } from "../../../lib/store";
import { demoGpuProfile, runpodGpuProfile } from "../../../lib/resource-profiles";
import { listRunBoxJobs, migrateRunBoxJobs, saveRunBoxDecision } from "../../../lib/run-box-jobs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new InputError(`Invalid ${name}`);
  return value;
}

export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    const projectId = identifier(input.projectId, "project ID");
    const resourceRequestId = identifier(input.resourceRequestId, "resource request ID");
    const idempotencyKey = identifier(input.idempotencyKey, "idempotency key");
    if (idempotencyKey.length > 128) throw new InputError("Invalid idempotency key");
    const membership = requireMembership(employee, projectId);
    const project = (await getState()).projects.find((item) => item.id === projectId);
    if (!project) throw new InputError("Project not found", 404);
    const resourceRequest = project.resourceRequests.find((item) => item.id === resourceRequestId);
    if (!resourceRequest) throw new InputError("Resource request not found", 404);
    if (membership.role === "member" && resourceRequest.requestedBy?.employeeId !== employee.id)
      throw new InputError("Only the requester or project owner may decide this request", 403);
    const preference = resourceRequest.computePreference;
    const awsEligible = preference?.provider === "aws-ec2" &&
      preference.profileId === demoGpuProfile.id && preference.region === demoGpuProfile.region &&
      preference.instanceType === demoGpuProfile.instanceType;
    const runpodEligible = preference?.provider === "runpod" &&
      preference.profileId === runpodGpuProfile.id && preference.gpuId === runpodGpuProfile.gpuId &&
      preference.cloud === runpodGpuProfile.cloud && preference.maxHourlyUsd === runpodGpuProfile.maxHourlyUsd;
    if (resourceRequest.kind !== "gpu" || resourceRequest.status !== "requested" ||
        resourceRequest.decision.status !== "not_evaluated" ||
        !preference || (!awsEligible && !runpodEligible) ||
        ![1, 2].includes(preference.durationHours) ||
        resourceRequest.requestedBy?.organizationId !== employee.activeOrganization?.id)
      throw new InputError("Resource request is not eligible for this run-box policy", 409);
    migrateRunBoxJobs(getDatabase());
    let result;
    try {
      result = saveRunBoxDecision(getDatabase(), {
        idempotencyKey, resourceRequestId, projectId,
        employeeId: employee.id,
        organizationId: employee.activeOrganization!.id,
        projectRole: membership.role,
        provider: preference.provider,
        profileId: preference.profileId,
        maxDurationMinutes: preference.durationHours * 60,
        repoUrl: project.repo,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "Invalid repository URL")
        throw new InputError("Project repository URL is not eligible for a run box", 409);
      if (error instanceof Error && /Idempotency key reused|already has a run-box decision|AWS run box is already active/.test(error.message))
        throw new InputError(error.message, 409);
      throw error;
    }
    return Response.json(result, { status: result.decision.outcome === "approved" ? 201 : 200 });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request) {
  try {
    const employee = await requireEmployee(request);
    const projectId = identifier(new URL(request.url).searchParams.get("projectId"), "project ID");
    requireMembership(employee, projectId);
    migrateRunBoxJobs(getDatabase());
    return Response.json({ jobs: listRunBoxJobs(getDatabase(), projectId) });
  } catch (error) {
    return failure(error);
  }
}
