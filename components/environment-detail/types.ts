// Shape of one job from GET /api/run-boxes/:id (docs/environment-model-contract.md).
// Fields added by the environment model are optional so an older server still renders;
// the UI never invents them.
import {
  awsCpuProfile,
  demoGpuProfile,
  localDockerSandboxProfile,
  runpodBudgetGpuProfile,
  runpodGpuProfile,
} from "@/lib/resource-profiles";

export type RunBoxJobState =
  | "queued"
  | "allocating"
  | "connecting"
  | "verifying"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

/** Machine facts from lib/machine-catalog.mjs as returned on the job (null for non-catalog profiles). */
export type RunBoxMachine = {
  id: string;
  kind: "cpu" | "gpu";
  size: string;
  instanceType: string;
  vcpu: number;
  memoryGib: number;
  gpu: null | { model: string; count: number; memoryGib: number };
};

export type RunBoxPermissions = { open: boolean; stop: boolean; manage: boolean };

export type RunBoxJob = {
  id: string;
  provider: "aws-ec2" | "runpod" | "docker-local" | "ssh-host";
  profile_id?: string | null;
  profileId?: string | null;
  state: RunBoxJobState;
  provider_resource_id: string | null;
  max_duration_minutes: number;
  stop_requested_at: string | null;
  force_stop_requested_at?: string | null;
  created_at: string;
  updated_at?: string;
  failure_reason?: string | null;
  failureReason?: string | null;
  repo_url?: string | null;
  repo_revision?: string | null;
  ssh?: { host: string; port: number; username?: string } | null;
  machine?: RunBoxMachine | null;
  diskGb?: number | null;
  name?: string | null;
  visibility?: "private" | "public";
  createdBy?: { id: string; name: string; email: string } | null;
  permissions?: RunBoxPermissions;
  /** Shared project memory (Backboard): `available` is false when the server has no key. */
  memory?: { enabled: boolean; available: boolean };
};

export const memoryExplanation =
  "When on, Codex in this environment recalls facts saved by the project's other environments and saves a short note of each request.";

/** "On", "Off", or "On · not configured on this server". */
export function memoryStatus(job: Pick<RunBoxJob, "memory">) {
  const enabled = job.memory?.enabled === true;
  if (job.memory && !job.memory.available) return `${enabled ? "On" : "Off"} · not configured on this server`;
  return enabled ? "On" : "Off";
}

export const noPermissions: RunBoxPermissions = { open: false, stop: false, manage: false };

export function shortId(job: Pick<RunBoxJob, "id">) {
  return job.id.slice(0, 8);
}

export function environmentName(job: Pick<RunBoxJob, "id" | "name">) {
  return job.name?.trim() || `Unnamed environment · ${shortId(job)}`;
}

export const stateLabels: Record<RunBoxJobState, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Approved and waiting for a worker. No machine exists yet." },
  allocating: { label: "Allocating", detail: "A worker is checking limits and creating the machine." },
  connecting: { label: "Connecting", detail: "The machine was allocated. The worker is establishing SSH access." },
  verifying: { label: "Verifying", detail: "The worker is checking the pinned host key, workspace, and hardware." },
  ready: { label: "Ready", detail: "The worker verified SSH access against the host key it generated." },
  stopping: { label: "Stopping", detail: "Shutdown can take several minutes. Waiting for the provider to confirm this environment is released." },
  stopped: { label: "Stopped", detail: "The worker recorded this environment as stopped." },
  failed: { label: "Failed", detail: "The worker recorded a failure. Request a stop so it confirms cleanup." },
};

export function stateInfo(state: RunBoxJobState) {
  return stateLabels[state] ?? stateLabels.failed;
}

const profileNames: Record<string, string> = {
  [localDockerSandboxProfile.id]: localDockerSandboxProfile.label,
  [awsCpuProfile.id]: "AWS EC2 CPU",
  [runpodBudgetGpuProfile.id]: "Runpod budget GPU",
  [runpodGpuProfile.id]: "Runpod RTX 4090",
  [demoGpuProfile.id]: "AWS EC2 g6 · NVIDIA L4",
};

/** A one-line machine label, e.g. "Medium · t3.xlarge". */
export function machineLabel(job: RunBoxJob) {
  if (job.machine) return `${job.machine.size} · ${job.machine.instanceType}`;
  const id = job.profileId ?? job.profile_id ?? "";
  if (profileNames[id]) return profileNames[id];
  if (id.startsWith("local-template:")) return "Local Docker template";
  return id || "Machine not recorded";
}

/** Hardware specs from the machine catalog, or null when the job does not carry them. */
export function machineSpecs(job: RunBoxJob) {
  const machine = job.machine;
  if (!machine) return null;
  const parts = [`${machine.vcpu} vCPU`, `${machine.memoryGib} GiB memory`];
  if (machine.gpu)
    parts.push(`${machine.gpu.count > 1 ? `${machine.gpu.count}× ` : ""}${machine.gpu.model} (${machine.gpu.memoryGib} GiB)`);
  else parts.push("no GPU");
  if (job.diskGb) parts.push(`${job.diskGb} GiB disk`);
  return parts.join(" · ");
}

export function providerLabel(provider: RunBoxJob["provider"]) {
  switch (provider) {
    case "runpod":
      return "Runpod";
    case "aws-ec2":
      return "AWS EC2";
    case "docker-local":
      return "Local Docker";
    default:
      return "SSH host";
  }
}

export function expiresAt(job: RunBoxJob) {
  return Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
}

/** "1h 20m left", "Expired", or "Ended" for jobs that are no longer active. */
export function timeLeft(job: RunBoxJob, now: number) {
  if (job.state === "stopped" || job.state === "failed") return "Ended";
  const remaining = expiresAt(job) - now;
  if (!Number.isFinite(remaining)) return "Unknown";
  if (remaining <= 0) return "Time limit reached";
  const minutes = Math.ceil(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m left` : `${minutes}m left`;
}

export function readableDate(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}
