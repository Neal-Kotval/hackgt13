import { getDatabase } from "../../../lib/auth.mjs";
import { requireEmployee, requireMembership, type Employee } from "../../../lib/employee";
import { body, failure, sameOrigin } from "../../../lib/http";
import { InputError, getState, resourceAction } from "../../../lib/store";
import { demoGpuProfile, localDockerSandboxProfile, runpodGpuProfile } from "../../../lib/resource-profiles";
import { listRunBoxJobs, migrateRunBoxJobs, saveRunBoxDecision } from "../../../lib/run-box-jobs.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function identifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256)
    throw new InputError(`Invalid ${name}`);
  return value;
}

// Server-owned environment profiles for the one-step path. Clients choose an ID;
// provider, hardware, and price limits come only from lib/resource-profiles.ts.
const environmentProfiles = {
  [localDockerSandboxProfile.id]: { provider: localDockerSandboxProfile.provider, kind: "run-box", label: localDockerSandboxProfile.label },
  [runpodGpuProfile.id]: { provider: runpodGpuProfile.provider, kind: "gpu", label: runpodGpuProfile.label },
  [demoGpuProfile.id]: { provider: demoGpuProfile.provider, kind: "gpu", label: `AWS EC2 · ${demoGpuProfile.label}` },
} as const;
type EnvironmentProfileId = keyof typeof environmentProfiles;
type DecisionRow = {
  id: string; project_id: string; employee_id: string; provider: string;
  profile_id: string | null; max_duration_minutes: number; outcome: string;
};
type Database = ReturnType<typeof getDatabase>;

function decisionError(error: unknown): never {
  if (error instanceof Error && error.message === "Invalid repository URL")
    throw new InputError("Project repository URL is not eligible for a run box", 409);
  if (error instanceof Error && /Idempotency key reused|already has a run-box decision|run box is already active/.test(error.message))
    throw new InputError(error.message, 409);
  throw error;
}

function providerSupported(db: Database, provider: string) {
  // Until a provider is added to lib/run-box-jobs.mjs, its schema CHECK rejects it.
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'run_box_job'").get() as { sql: string } | undefined;
  return Boolean(table?.sql.includes(`'${provider}'`));
}

function existingDecision(db: Database, idempotencyKey: string) {
  const decision = db.prepare("SELECT * FROM run_box_decision WHERE idempotency_key = ?").get(idempotencyKey) as DecisionRow | undefined;
  if (!decision) return null;
  const job = db.prepare("SELECT * FROM run_box_job WHERE decision_id = ?").get(decision.id) || null;
  return { decision, job };
}

function respond(result: { decision: { outcome: string } }) {
  return Response.json(result, { status: result.decision.outcome === "approved" ? 201 : 200 });
}

// Serialize one-step creation per idempotency key so a retry cannot record a
// second resource request while the first is still being decided.
const pending = new Map<string, Promise<unknown>>();

async function createEnvironment(employee: Employee, input: Record<string, unknown>) {
  for (const key of Object.keys(input))
    if (!["projectId", "profileId", "durationHours", "idempotencyKey"].includes(key))
      throw new InputError(`Unsupported field: ${key}`);
  const projectId = identifier(input.projectId, "project ID");
  const idempotencyKey = identifier(input.idempotencyKey, "idempotency key");
  if (idempotencyKey.length > 128) throw new InputError("Invalid idempotency key");
  if (typeof input.profileId !== "string" || !Object.hasOwn(environmentProfiles, input.profileId))
    throw new InputError("Unsupported environment profile");
  const profileId = input.profileId as EnvironmentProfileId;
  const durationHours = input.durationHours;
  if (durationHours !== 1 && durationHours !== 2) throw new InputError("Duration must be 1 or 2 hours");
  const membership = requireMembership(employee, projectId);
  const organizationId = employee.activeOrganization?.id;
  if (!organizationId) throw new InputError("Active organization required", 403);
  const profile = environmentProfiles[profileId];
  const project = (await getState()).projects.find((item) => item.id === projectId);
  if (!project) throw new InputError("Project not found", 404);
  const db = getDatabase();
  migrateRunBoxJobs(db);

  const prior = existingDecision(db, idempotencyKey);
  if (prior) {
    const { decision } = prior;
    if (decision.project_id !== projectId || decision.employee_id !== employee.id ||
        decision.provider !== profile.provider || decision.max_duration_minutes !== durationHours * 60 ||
        (decision.profile_id !== null && decision.profile_id !== profileId))
      throw new InputError("Idempotency key reused for a different decision", 409);
    return respond(prior);
  }
  if (!providerSupported(db, profile.provider))
    throw new InputError(`${profile.label} is not available on this server yet`, 409);
  // Check the single-active-box guard before recording a request so a refusal
  // does not leave an undecided request in the project history.
  if (membership.role === "owner" && ["aws-ec2", "runpod"].includes(profile.provider) &&
      db.prepare("SELECT id FROM run_box_job WHERE provider = ? AND state != 'stopped' LIMIT 1").get(profile.provider))
    throw new InputError(profile.provider === "aws-ec2" ? "An AWS run box is already active" : "A Runpod run box is already active", 409);

  const { request: resourceRequest } = await resourceAction({
    type: "requestResource",
    projectId,
    kind: profile.kind,
    purpose: `Environment: ${profile.label} for ${durationHours} ${durationHours === 1 ? "hour" : "hours"}`,
    gpuProfileId: profileId,
    durationHours,
  }, { employeeId: employee.id, organizationId, projectRole: membership.role });
  if (!resourceRequest) throw new Error("Resource request was not recorded");
  try {
    return respond(saveRunBoxDecision(db, {
      idempotencyKey,
      resourceRequestId: resourceRequest.id,
      projectId,
      employeeId: employee.id,
      organizationId,
      projectRole: membership.role,
      provider: profile.provider,
      profileId,
      maxDurationMinutes: durationHours * 60,
      repoUrl: project.repo,
    }));
  } catch (error) {
    decisionError(error);
  }
}

export async function POST(request: Request) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const input = await body(request);
    if (input.resourceRequestId === undefined && input.profileId !== undefined) {
      const key = `${employee.id}:${String(input.idempotencyKey)}`;
      const operation = (pending.get(key) ?? Promise.resolve())
        .catch(() => {})
        .then(() => createEnvironment(employee, input));
      pending.set(key, operation);
      try { return await operation; } finally { if (pending.get(key) === operation) pending.delete(key); }
    }
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
      decisionError(error);
    }
    return respond(result);
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
