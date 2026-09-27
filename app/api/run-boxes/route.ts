import { getDatabase } from "../../../lib/auth.mjs";
import { requireEmployee, requireMembership, type Employee } from "../../../lib/employee";
import { body, failure, sameOrigin } from "../../../lib/http";
import { InputError, getState, resourceAction } from "../../../lib/store";
import { awsCpuProfile, demoGpuProfile, findRunpodProfile, localDockerSandboxProfile, runpodBudgetGpuProfile, runpodGpuProfile } from "../../../lib/resource-profiles";
import { listRunBoxJobs, migrateRunBoxJobs, saveRunBoxDecision } from "../../../lib/run-box-jobs.mjs";
import { getRunBoxSshEndpoint, migrateRunBoxSsh } from "../../../lib/run-box-ssh.mjs";
import { getAgentCheck, getWorkspacePath, migrateAgentCheck } from "../../../lib/agent-check.mjs";
import { getContainerTemplate, listContainerTemplates, templateIdFromProfile } from "../../../lib/container-templates.mjs";
import { requestAwsCpuSshAccess, trustedRequesterCidr } from "../../../lib/aws-cpu-ssh-access.mjs";
import { defaultBackboardFile, environmentMemory, projectMemoryStatus } from "../../../lib/backboard-memory.mjs";

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
  [runpodBudgetGpuProfile.id]: { provider: runpodBudgetGpuProfile.provider, kind: "gpu", label: runpodBudgetGpuProfile.label },
  [demoGpuProfile.id]: { provider: demoGpuProfile.provider, kind: "gpu", label: `AWS EC2 · ${demoGpuProfile.label}` },
  [awsCpuProfile.id]: { provider: awsCpuProfile.provider, kind: "run-box", label: awsCpuProfile.label },
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
  if (error instanceof Error && error.message === "A local Docker sandbox is already active for this project")
    throw new InputError("A local Docker sandbox is already active for this project. Use the existing environment or stop it before creating another.", 409);
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

// HAC-168: the single-active guard spans every project, so say where the blocking
// environment is — by name only when the caller is a member of that project.
function activeBoxMessage(employee: Employee, provider: string, blocking: { project_id: string; state: string },
  projects: { id: string; name: string }[]) {
  const base = provider === "aws-ec2" ? "An AWS run box is already active" : "A Runpod run box is already active";
  const visible = employee.memberships.some((item) => item.projectId === blocking.project_id);
  if (!visible)
    return `${base} in another project. Only one is allowed at a time; ask that project's owner to stop it, or force stop it from its Environments page.`;
  const name = projects.find((item) => item.id === blocking.project_id)?.name;
  return `${base} in ${name ? `"${name}"` : "one of your projects"} (${blocking.state}). Only one is allowed at a time; a project owner can stop or force stop it from that project's Environments page.`;
}

// Serialize one-step creation per idempotency key so a retry cannot record a
// second resource request while the first is still being decided.
const pending = new Map<string, Promise<unknown>>();

// `requesterCidr` is the caller's public /32 from the trusted CloudFront header
// (lib/aws-cpu-ssh-access.mjs), or null. It is used only for aws-cpu jobs.
async function createEnvironment(employee: Employee, input: Record<string, unknown>, requesterCidr: string | null) {
  for (const key of Object.keys(input))
    if (!["projectId", "profileId", "durationHours", "idempotencyKey"].includes(key))
      throw new InputError(`Unsupported field: ${key}`);
  const projectId = identifier(input.projectId, "project ID");
  const idempotencyKey = identifier(input.idempotencyKey, "idempotency key");
  if (idempotencyKey.length > 128) throw new InputError("Invalid idempotency key");
  if (typeof input.profileId !== "string" ||
      (!Object.hasOwn(environmentProfiles, input.profileId) && !templateIdFromProfile(input.profileId)))
    throw new InputError("Unsupported environment profile");
  const profileId = input.profileId;
  const durationHours = input.durationHours;
  if (durationHours !== 1 && durationHours !== 2) throw new InputError("Duration must be 1 or 2 hours");
  const membership = requireMembership(employee, projectId);
  const organizationId = employee.activeOrganization?.id;
  if (!organizationId) throw new InputError("Active organization required", 403);
  const templateId = templateIdFromProfile(profileId);
  const template = templateId ? getContainerTemplate(getDatabase(), templateId) : null;
  if (templateId && !template) throw new InputError("Container template is unavailable", 409);
  const profile = template ? { provider: "docker-local", kind: "run-box", label: template.label }
    : environmentProfiles[profileId as EnvironmentProfileId];
  const projects = (await getState()).projects;
  const project = projects.find((item) => item.id === projectId);
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
  if (membership.role === "owner" && ["aws-ec2", "runpod"].includes(profile.provider)) {
    const blocking = db.prepare("SELECT id, project_id, state FROM run_box_job WHERE provider = ? AND state != 'stopped' ORDER BY created_at LIMIT 1")
      .get(profile.provider) as { id: string; project_id: string; state: string } | undefined;
    if (blocking) throw new InputError(activeBoxMessage(employee, profile.provider, blocking, projects), 409);
  }

  if (membership.role === "owner" && profile.provider === "docker-local" &&
      db.prepare("SELECT id FROM run_box_job WHERE provider = 'docker-local' AND project_id = ? AND state != 'stopped' LIMIT 1").get(projectId))
    decisionError(new Error("A local Docker sandbox is already active for this project"));

  const { request: resourceRequest } = await resourceAction({
    type: "requestResource",
    projectId,
    kind: profile.kind,
    purpose: `Environment: ${profile.label} for ${durationHours} ${durationHours === 1 ? "hour" : "hours"}`,
    gpuProfileId: profileId,
    durationHours,
  }, { employeeId: employee.id, organizationId, projectRole: membership.role });
  if (!resourceRequest) throw new Error("Resource request was not recorded");
  let result;
  try {
    result = saveRunBoxDecision(db, {
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
    });
  } catch (error) {
    decisionError(error);
  }
  // HAC-166: the worker adds a tcp/22 rule for the requester's address next to its own.
  if (profileId === awsCpuProfile.id && result.job && requesterCidr)
    requestAwsCpuSshAccess(db, { jobId: result.job.id, cidr: requesterCidr, employeeId: employee.id, source: "create" });
  return respond(result);
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
        .then(() => createEnvironment(employee, input, trustedRequesterCidr(request.headers)));
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
    const runpodProfile = preference?.provider === "runpod" ? findRunpodProfile(preference.profileId) : null;
    const runpodEligible = preference?.provider === "runpod" && runpodProfile !== null &&
      preference.gpuId === runpodProfile.gpuId &&
      preference.cloud === runpodProfile.cloud && preference.maxHourlyUsd === runpodProfile.maxHourlyUsd;
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
    const db = getDatabase();
    migrateRunBoxJobs(db);
    migrateRunBoxSsh(db);
    migrateAgentCheck(db);
    const memoryAvailable = projectMemoryStatus().enabled;
    const memoryFile = defaultBackboardFile();
    const jobs = (listRunBoxJobs(db, projectId) as { id: string; state: string; profile_id: string | null; stop_requested_at: string | null }[])
      .map((job) => {
        const ready = job.state === "ready" && !job.stop_requested_at;
        const endpoint = ready ? getRunBoxSshEndpoint(db, job.id) : null;
        const codex = getAgentCheck(db, job.id, "codex");
        let memoryEnabled = false;
        try { memoryEnabled = environmentMemory(memoryFile, job.id).enabled; } catch { memoryEnabled = false; }
        return {
          ...job,
          profileId: job.profile_id,
          ssh: endpoint ? { host: endpoint.host, port: endpoint.port, username: endpoint.username } : null,
          desktopUrl: endpoint
            ? `agentcloud://open?${new URLSearchParams({ projectId, runBoxId: job.id })}`
            : null,
          access: "trusted-shell",
          // HAC-121: repo checkout path (null until ready) and agent readiness, separate from `state`.
          workspacePath: ready ? getWorkspacePath(db, job.id) : null,
          agent: { codex: { state: codex.state, version: codex.version, reason: codex.reason } },
          memory: { enabled: memoryEnabled, available: memoryAvailable },
        };
      });
    return Response.json({ jobs, templates: listContainerTemplates(db).map((item: {
      id: string; label: string; image_id: string; source: string;
    }) => ({ id: item.id, label: item.label, imageId: item.image_id, source: item.source })) });
  } catch (error) {
    return failure(error);
  }
}
