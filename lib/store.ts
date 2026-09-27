import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  State,
  Project,
  TaskStatus,
  ResourceKind,
  ResourceDefinition,
  ResourceRequest,
  InferenceConfiguration,
} from "./types";
import {
  demoGpuDurations,
  demoGpuProfile,
  localDockerSandboxProfile,
  findRunpodProfile,
} from "./resource-profiles";
interface Credential {
  hash: string;
  projectId: string;
  agentId: string;
}
interface Disk {
  state: State;
  credentials: Credential[];
}
const globals = globalThis as typeof globalThis & {
  agentcloudQueue?: Promise<unknown>;
};
const directory = () =>
  process.env.AGENTCLOUD_DATA_DIR || path.join(process.cwd(), ".agentcloud");
export class InputError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function str(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new InputError(
      `${name} must be a nonempty string (maximum ${max} characters)`,
    );
  return value.trim();
}
const id = () => randomUUID();
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
async function load(): Promise<Disk> {
  try {
    const disk = JSON.parse(
      await readFile(path.join(directory(), "state.json"), "utf8"),
    ) as Disk;
    // Records written before the resource catalog existed remain readable.
    for (const p of disk.state.projects) {
      p.resources ??= [];
      p.resourceRequests ??= [];
    }
    return disk;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { state: { projects: [], revision: 0 }, credentials: [] };
  }
}
async function save(data: Disk) {
  await mkdir(directory(), { recursive: true, mode: 0o700 });
  const tmp = path.join(directory(), `state-${id()}.tmp`);
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await rename(tmp, path.join(directory(), "state.json"));
}
function transaction<T>(fn: (disk: Disk) => T | Promise<T>): Promise<T> {
  const operation = (globals.agentcloudQueue || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const data = await load();
      const result = await fn(data);
      await save(data);
      return result;
    });
  globals.agentcloudQueue = operation;
  return operation;
}
export async function getState(): Promise<State> {
  await globals.agentcloudQueue?.catch(() => {});
  return visibleState((await load()).state);
}
export function visibleState(state: State, now = Date.now()): State {
  const publicState = structuredClone(state);
  for (const p of publicState.projects) {
    for (const a of p.agents) {
      if (
        a.status === "connected" &&
        (!a.lastSeen || now - Date.parse(a.lastSeen) > 45000)
      )
        a.status = "disconnected";
    }
  }
  return publicState;
}
function projectInput(input: Record<string, unknown>) {
  const repo = str(input.repo, "repo");
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    throw new InputError("Repository must be an HTTPS URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  )
    throw new InputError("Repository must be an HTTPS URL without credentials");
  const compute = str(input.compute, "compute");
  if (!["Hosted Linux", "SSH machine"].includes(compute))
    throw new InputError("Choose Hosted Linux or SSH machine");
  let host: string | undefined;
  if (compute === "SSH machine") {
    host = str(input.host, "SSH host", 300);
    if (!/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
      throw new InputError("SSH host must be a hostname or user@hostname");
  }
  return { repo, compute, host };
}
function project(disk: Disk, projectId: unknown): Project {
  const p = disk.state.projects.find((p) => p.id === projectId);
  if (!p) throw new InputError("Project not found", 404);
  return p;
}
function event(p: Project, actor: string, text: string, kind = "activity") {
  p.events.unshift({
    id: id(),
    time: new Date().toISOString(),
    actor,
    text,
    kind,
  });
  p.events = p.events.slice(0, 500);
}
function agent(p: Project, agentId: unknown) {
  const a = p.agents.find((a) => a.id === agentId);
  if (!a) throw new InputError("Agent not found", 404);
  return a;
}
function setTask(p: Project, taskId: unknown, value: unknown, actor: string) {
  const task = p.tasks.find((t) => t.id === taskId);
  if (!task) throw new InputError("Task not found", 404);
  if (!["queued", "in progress", "blocked", "done"].includes(String(value)))
    throw new InputError("Invalid task status");
  if (
    (value === "in progress" || value === "done") &&
    task.dependency &&
    p.tasks.find((t) => t.id === task.dependency)?.status !== "done"
  )
    throw new InputError("Complete the dependency first", 409);
  task.status = value as TaskStatus;
  event(p, actor, `${task.title}: ${task.status}`, "task");
}
export async function action(input: Record<string, unknown>) {
  return transaction(async (disk) => {
    let result: Record<string, unknown> = {};
    if (input.type === "createProject") {
      const projectId = id();
      const { repo, compute, host } = projectInput(input);
      const p: Project = {
        id: projectId,
        name: str(input.name, "name", 100),
        repo,
        template: str(input.template, "template", 100),
        compute,
        host,
        agents: [],
        tasks: [],
        services: [],
        handoffs: [],
        events: [],
        resources: [],
        resourceRequests: [],
        createdAt: new Date().toISOString(),
      };
      event(
        p,
        "human",
        "Project saved. Workspace provisioning is pending; attach a real workspace outside this MVP.",
        "project",
      );
      disk.state.projects.push(p);
      result = { id: projectId };
    } else {
      const p = project(disk, input.projectId);
      switch (input.type) {
        case "addTask": {
          const owner = str(input.owner, "owner");
          agent(p, owner);
          const dependency =
            typeof input.dependency === "string" && input.dependency
              ? input.dependency
              : undefined;
          if (dependency && !p.tasks.some((t) => t.id === dependency))
            throw new InputError("Dependency not found");
          const instructions =
            input.instructions === undefined || input.instructions === ""
              ? undefined
              : str(input.instructions, "instructions", 4000);
          const environmentId = optionalReference(
            input.environmentId,
            "Environment",
            (value) => p.resources.some((resource) => resource.id === value),
          );
          if (environmentId) {
            const resource = p.resources.find(
              (row) => row.id === environmentId,
            );
            if (!resource || resource.status !== "verified") {
              throw new InputError(
                "Environment must be verified before binding a task",
              );
            }
          }
          const runBoxId = input.runBoxId === undefined || input.runBoxId === ""
            ? undefined
            : str(input.runBoxId, "runBoxId", 100);
          if (runBoxId && environmentId)
            throw new InputError("Choose one task environment");
          if (runBoxId) {
            const [{ getDatabase }, { getRunBoxJob, migrateRunBoxJobs }] = await Promise.all([
              import("./auth.mjs"),
              import("./run-box-jobs.mjs"),
            ]);
            const db = getDatabase();
            migrateRunBoxJobs(db);
            const runBox = getRunBoxJob(db, runBoxId);
            if (!runBox || runBox.project_id !== p.id)
              throw new InputError("Run box not found", 404);
            if (runBox.state !== "ready" || runBox.stop_requested_at)
              throw new InputError("Run box must be ready before binding a task", 409);
          }
          p.tasks.push({
            id: id(),
            title: str(input.title, "title", 200),
            owner,
            status: "queued",
            dependency,
            ...(instructions ? { instructions } : {}),
            ...(environmentId ? { environmentId } : {}),
            ...(runBoxId ? { runBoxId } : {}),
          });
          event(p, "human", "Created a task", "task");
          break;
        }
        case "taskStatus":
          setTask(p, input.taskId, input.status, "human");
          break;
        case "acceptHandoff": {
          const h = p.handoffs.find((h) => h.id === input.handoffId);
          if (!h) throw new InputError("Handoff not found", 404);
          if (h.accepted) {
            result = { taskId: p.tasks.find((t) => t.handoffId === h.id)?.id };
            break;
          }
          agent(p, h.to);
          const normalized = (text: string) => text.trim().toLowerCase();
          const title = h.next.slice(0, 200);
          let followup = p.tasks.find(
            (t) =>
              t.owner === h.to &&
              t.status !== "done" &&
              [normalized(h.title), normalized(title)].includes(
                normalized(t.title),
              ),
          );
          if (!followup) {
            followup = {
              id: id(),
              title,
              owner: h.to,
              status: "queued",
              handoffId: h.id,
            };
            p.tasks.push(followup);
          } else followup.handoffId = h.id;
          h.accepted = true;
          result = { taskId: followup.id };
          event(
            p,
            "human",
            `Accepted handoff and assigned follow-up to ${agent(p, h.to).name}: ${h.title}`,
            "handoff",
          );
          break;
        }
        case "addAgent": {
          const client = str(input.client, "client", 80);
          const agentId = id();
          const token = randomBytes(32).toString("base64url");
          p.agents.push({
            id: agentId,
            name: client,
            client,
            role: str(input.role, "role", 100),
            branch: `agents/${agentId.slice(0, 8)}`,
            status: "disconnected",
          });
          disk.credentials.push({
            hash: hash(token),
            projectId: p.id,
            agentId,
          });
          event(
            p,
            "human",
            `Created ${client} connection identity; workspace branch is planned, not provisioned`,
            "agent",
          );
          result = { token, agentId };
          break;
        }
        case "rotateAgentToken":
        case "revokeAgentToken": {
          const a = agent(p, input.agentId);
          disk.credentials = disk.credentials.filter(
            (credential) => credential.projectId !== p.id || credential.agentId !== a.id,
          );
          a.status = "disconnected";
          delete a.lastSeen;
          if (input.type === "rotateAgentToken") {
            const token = randomBytes(32).toString("base64url");
            disk.credentials.push({ hash: hash(token), projectId: p.id, agentId: a.id });
            result = { agentId: a.id, token };
          } else result = { agentId: a.id };
          event(p, "human", `${input.type === "rotateAgentToken" ? "Rotated" : "Revoked"} connection token for ${a.name}`, "agent");
          break;
        }
        default:
          throw new InputError("Unsupported action");
      }
    }
    disk.state.revision++;
    return { state: visibleState(disk.state), ...result };
  });
}
const resourceKinds: ResourceKind[] = [
  "run-box",
  "gpu",
  "data-source",
  "service",
  "inference-api",
];
function resourceKind(value: unknown): ResourceKind {
  if (!resourceKinds.includes(value as ResourceKind))
    throw new InputError("Invalid resource kind");
  return value as ResourceKind;
}
function fields(input: Record<string, unknown>, names: string[]) {
  for (const key of Object.keys(input))
    if (!names.includes(key)) throw new InputError(`Unsupported field: ${key}`);
}
function optionalReference(
  value: unknown,
  name: string,
  exists: (id: string) => boolean,
): string | undefined {
  if (value === undefined || value === "") return undefined;
  const reference = str(value, name, 100);
  if (!exists(reference)) throw new InputError(`${name} not found`, 404);
  return reference;
}
export interface ResourceActor {
  employeeId: string;
  organizationId: string;
  projectRole: "owner" | "member";
}
export async function resourceAction(
  input: Record<string, unknown>,
  actor: ResourceActor,
) {
  return transaction((disk) => {
    const p = project(disk, input.projectId);
    const now = new Date().toISOString();
    let result: { resource?: ResourceDefinition; request?: ResourceRequest } =
      {};
    switch (input.type) {
      case "registerResource": {
        fields(input, [
          "type",
          "projectId",
          "name",
          "kind",
          "capability",
          "owner",
        ]);
        if (p.resources.length >= 200)
          throw new InputError("Resource limit reached", 409);
        const kind = resourceKind(input.kind);
        if (kind === "inference-api")
          throw new InputError("Use an inference draft for an inference API");
        const resource: ResourceDefinition = {
          id: id(),
          name: str(input.name, "name", 100),
          kind,
          capability: str(input.capability, "capability", 500),
          owner: str(input.owner, "owner", 100),
          status: "registered",
          createdAt: now,
          updatedAt: now,
        };
        p.resources.push(resource);
        event(
          p,
          "human",
          `Registered ${resource.name} in the catalog; availability unverified`,
          "resource",
        );
        result = { resource };
        break;
      }
      case "saveInferenceDraft": {
        fields(input, [
          "type",
          "projectId",
          "name",
          "kind",
          "capability",
          "owner",
          "inference",
        ]);
        if (input.kind !== undefined && input.kind !== "inference-api")
          throw new InputError("Inference draft kind must be inference-api");
        if (p.resources.length >= 200)
          throw new InputError("Resource limit reached", 409);
        const raw = input.inference;
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new InputError("Inference configuration is required");
        const configuration = raw as Record<string, unknown>;
        fields(configuration, ["model", "hardware", "accessScope", "lifetime"]);
        const inference: InferenceConfiguration = {
          model: str(configuration.model, "model", 200),
          hardware: str(configuration.hardware, "hardware", 200),
          accessScope: str(configuration.accessScope, "accessScope", 200),
          lifetime: str(configuration.lifetime, "lifetime", 100),
        };
        const resource: ResourceDefinition = {
          id: id(),
          name: str(input.name, "name", 100),
          kind: "inference-api",
          capability: str(input.capability, "capability", 500),
          owner: str(input.owner, "owner", 100),
          status: "draft",
          inference,
          createdAt: now,
          updatedAt: now,
        };
        p.resources.push(resource);
        event(
          p,
          "human",
          `Saved inference API draft ${resource.name}; no serving process started`,
          "resource",
        );
        result = { resource };
        break;
      }
      case "requestResource": {
        fields(input, [
          "type",
          "projectId",
          "resourceId",
          "kind",
          "taskId",
          "agentId",
          "purpose",
          "gpuProfileId",
          "durationHours",
        ]);
        if (p.resourceRequests.length >= 500)
          throw new InputError("Resource request limit reached", 409);
        const resourceId = optionalReference(
          input.resourceId,
          "Resource",
          (value) => p.resources.some((resource) => resource.id === value),
        );
        const resource = p.resources.find((item) => item.id === resourceId);
        const kind =
          input.kind === undefined && resource
            ? resource.kind
            : resourceKind(input.kind);
        if (resource && kind !== resource.kind)
          throw new InputError("Requested kind does not match resource");
        const hasGpuPreference =
          input.gpuProfileId !== undefined || input.durationHours !== undefined;
        // The CPU-only local sandbox is a run box, never a GPU request.
        const isLocalSandbox = input.gpuProfileId === localDockerSandboxProfile.id;
        if (
          hasGpuPreference &&
          (resourceId ||
            kind !== (isLocalSandbox ? "run-box" : "gpu") ||
            (input.gpuProfileId !== demoGpuProfile.id &&
              !findRunpodProfile(input.gpuProfileId) &&
              !isLocalSandbox) ||
            typeof input.durationHours !== "number" ||
            !demoGpuDurations.some((hours) => hours === input.durationHours))
        )
          throw new InputError("Unsupported GPU profile or duration");
        const taskId = optionalReference(input.taskId, "Task", (value) =>
          p.tasks.some((task) => task.id === value),
        );
        const agentId = optionalReference(input.agentId, "Agent", (value) =>
          p.agents.some((agent) => agent.id === value),
        );
        const request: ResourceRequest = {
          id: id(),
          ...(resourceId ? { resourceId } : {}),
          kind,
          ...(taskId ? { taskId } : {}),
          ...(agentId ? { agentId } : {}),
          purpose: str(input.purpose, "purpose", 2000),
          requestedBy: {
            employeeId: actor.employeeId,
            organizationId: actor.organizationId,
            projectRoleAtRequest: actor.projectRole,
          },
          ...(hasGpuPreference
            ? {
                computePreference: isLocalSandbox ? {
                  provider: localDockerSandboxProfile.provider,
                  profileId: localDockerSandboxProfile.id,
                  durationHours: input.durationHours as number,
                } : findRunpodProfile(input.gpuProfileId) ? {
                  provider: "runpod",
                  profileId: findRunpodProfile(input.gpuProfileId)!.id,
                  gpuId: findRunpodProfile(input.gpuProfileId)!.gpuId,
                  cloud: "SECURE",
                  durationHours: input.durationHours as number,
                  maxHourlyUsd: findRunpodProfile(input.gpuProfileId)!.maxHourlyUsd,
                } : {
                  provider: demoGpuProfile.provider,
                  profileId: demoGpuProfile.id,
                  region: demoGpuProfile.region,
                  instanceType: demoGpuProfile.instanceType,
                  durationHours: input.durationHours as number,
                  estimatedComputeUsd: Number(
                    (
                      demoGpuProfile.hourlyComputeUsd *
                      (input.durationHours as number)
                    ).toFixed(4),
                  ),
                  quotedAt: demoGpuProfile.quotedAt,
                },
              }
            : {}),
          status: "requested",
          decision: {
            status: "not_evaluated",
            reason: "Resource policy is not configured.",
          },
          createdAt: now,
        };
        p.resourceRequests.push(request);
        event(
          p,
          "human",
          `Requested ${kind} resource; policy decision unavailable`,
          "resource",
        );
        result = { request };
        break;
      }
      default:
        throw new InputError("Unsupported resource action");
    }
    disk.state.revision++;
    return { state: visibleState(disk.state), ...result };
  });
}
export async function agentAction(
  token: string,
  input: Record<string, unknown>,
) {
  return transaction((disk) => {
    const credential = disk.credentials.find((c) => c.hash === hash(token));
    if (!credential) throw new InputError("Invalid agent token", 401);
    const p = project(disk, credential.projectId);
    const a = agent(p, credential.agentId);
    if (
      (input.projectId && input.projectId !== p.id) ||
      (input.agentId && input.agentId !== a.id)
    )
      throw new InputError(
        "Token cannot access another identity or project",
        403,
      );
    let result: Record<string, unknown> = {};
    switch (input.type) {
      case "connect":
      case "heartbeat":
        a.status = "connected";
        a.lastSeen = new Date().toISOString();
        if (input.type === "connect")
          event(p, a.id, `${a.name} connected through the CLI`, "agent");
        break;
      case "context":
        return {
          project: structuredClone(p),
          agentId: a.id,
          access: "coordination-only; no shell or filesystem access",
        };
      case "task": {
        const t = p.tasks.find((t) => t.id === input.taskId);
        if (!t) throw new InputError("Task not found", 404);
        if (t.owner !== a.id)
          throw new InputError("Agents can only update their own tasks", 403);
        setTask(p, t.id, input.status, a.id);
        break;
      }
      case "service": {
        const url = str(input.url, "url");
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new InputError("Invalid service URL");
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new InputError("Services must use HTTP or HTTPS");
        const service = {
          id: id(),
          name: str(input.name, "name", 100),
          url,
          owner: a.id,
          consumers: [],
          status: "registered",
        };
        p.services.push(service);
        result = { service };
        event(
          p,
          a.id,
          `Registered service ${service.name} (health unverified)`,
          "service",
        );
        break;
      }
      case "handoff": {
        const to = str(input.to, "to");
        agent(p, to);
        if (
          !Array.isArray(input.files) ||
          input.files.length > 100 ||
          input.files.some((f) => typeof f !== "string" || f.length > 500)
        )
          throw new InputError("files must be an array of paths");
        const h = {
          id: id(),
          from: a.id,
          to,
          title: str(input.title, "title", 200),
          summary: str(input.summary, "summary", 5000),
          files: input.files as string[],
          next: str(input.next, "next", 2000),
          accepted: false,
        };
        p.handoffs.push(h);
        event(
          p,
          a.id,
          `Sent handoff to ${agent(p, to).name}: ${h.title}`,
          "handoff",
        );
        result = { handoff: h };
        break;
      }
      default:
        throw new InputError("Unsupported agent operation", 403);
    }
    disk.state.revision++;
    return { project: structuredClone(p), agentId: a.id, ...result };
  });
}

const DESKTOP_CHAT_CLIENT = "desktop-chat";

/**
 * Resolve or create the project's desktop chat agent identity.
 * Never returns a plaintext credential token — chat uses the employee session.
 */
export async function ensureProjectChatAgent(
  projectId: string,
  agentId?: string,
): Promise<{ agentId: string; name: string; created: boolean }> {
  return transaction((disk) => {
    const p = project(disk, projectId);
    if (agentId) {
      const existing = agent(p, agentId);
      return {
        agentId: existing.id,
        name: existing.name,
        created: false,
      };
    }
    const named = p.agents.find(
      (row) =>
        row.client === DESKTOP_CHAT_CLIENT || row.name === DESKTOP_CHAT_CLIENT,
    );
    if (named) {
      return { agentId: named.id, name: named.name, created: false };
    }
    const createdId = id();
    const token = randomBytes(32).toString("base64url");
    p.agents.push({
      id: createdId,
      name: DESKTOP_CHAT_CLIENT,
      client: DESKTOP_CHAT_CLIENT,
      role: "Desktop project chat",
      branch: `agents/${createdId.slice(0, 8)}`,
      status: "disconnected",
    });
    disk.credentials.push({
      hash: hash(token),
      projectId: p.id,
      agentId: createdId,
    });
    event(
      p,
      "human",
      `Created ${DESKTOP_CHAT_CLIENT} connection identity for project chat; workspace branch is planned, not provisioned`,
      "agent",
    );
    disk.state.revision++;
    return {
      agentId: createdId,
      name: DESKTOP_CHAT_CLIENT,
      created: true,
    };
  });
}

/** Attribute a desktop chat turn without storing message contents. */
export async function recordProjectChatTurn(
  projectId: string,
  actor: string,
  agentName: string,
): Promise<void> {
  await transaction((disk) => {
    const p = project(disk, projectId);
    event(
      p,
      actor,
      `Desktop chat turn with project agent ${agentName}`,
      "agent",
    );
    disk.state.revision++;
  });
}
