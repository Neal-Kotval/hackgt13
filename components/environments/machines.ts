// Display helpers shared by the environment picker, environment cards, the project
// list, and the project overview. Hardware facts come from lib/machine-catalog.mjs
// (the server-side allowlist) or from the job listing; nothing here invents state.
import { defaultDiskGib, findMachine, type Machine } from "@/lib/machine-catalog.mjs";
import {
  demoGpuProfile,
  localDockerSandboxProfile,
  runpodBudgetGpuProfile,
  runpodGpuProfile,
} from "@/lib/resource-profiles";

export type JobState =
  | "queued"
  | "allocating"
  | "connecting"
  | "verifying"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

/** Machine facts as returned by GET /api/run-boxes (null for non-catalog profiles). */
export type JobMachine = {
  id: string;
  kind: "cpu" | "gpu";
  size: string;
  instanceType: string;
  vcpu: number;
  memoryGib: number;
  gpu: null | { model: string; count: number; memoryGib: number };
};

// Shape of GET /api/run-boxes?projectId= (docs/sandbox-mvp-contract.md). Optional
// fields may be absent on older servers; the UI never invents them.
export type EnvironmentJob = {
  id: string;
  resource_request_id: string;
  provider: "aws-ec2" | "runpod" | "docker-local" | "ssh-host";
  profile_id?: string | null;
  profileId?: string | null;
  state: JobState;
  provider_resource_id: string | null;
  max_duration_minutes: number;
  stop_requested_at: string | null;
  force_stop_requested_at?: string | null;
  created_at: string;
  outcome?: "approved" | "denied";
  decision_reason?: string;
  failure_reason?: string | null;
  failureReason?: string | null;
  ssh?: { host: string; port: number; username?: string } | null;
  desktopUrl?: string | null;
  access?: "trusted-shell";
  memory?: { enabled: boolean; available: boolean };
  repo_url?: string | null;
  repo_revision?: string | null;
  machine?: JobMachine | null;
  diskGb?: number | null;
};

export type ContainerTemplate = { id: string; label: string; imageId: string; source: string };

// Profiles no longer offered by the picker still label existing jobs.
const legacyProfileLabels: Record<string, string> = {
  [localDockerSandboxProfile.id]: "Local Docker sandbox",
  [runpodGpuProfile.id]: "Runpod RTX 4090",
  [runpodBudgetGpuProfile.id]: "Runpod budget GPU",
  [demoGpuProfile.id]: "AWS g6 · NVIDIA L4 (SSM)",
};

export function jobProfileId(job: Pick<EnvironmentJob, "profileId" | "profile_id">) {
  return job.profileId ?? job.profile_id ?? null;
}

/** The job's machine: the listing's `machine`, else the catalog entry for its profile. */
export function jobMachine(job: EnvironmentJob): JobMachine | null {
  if (job.machine) return job.machine;
  const id = jobProfileId(job);
  const machine = id ? findMachine(id) : null;
  return machine ? catalogMachine(machine) : null;
}

function catalogMachine(machine: Machine): JobMachine {
  const { id, kind, size, instanceType, vcpu, memoryGib, gpu } = machine;
  return { id, kind, size, instanceType, vcpu, memoryGib, gpu };
}

/** Disk size in GiB: the listing's `diskGb`, else the catalog default for its machine. */
export function jobDiskGib(job: EnvironmentJob): number | null {
  if (typeof job.diskGb === "number") return job.diskGb;
  const id = jobProfileId(job);
  const machine = id ? findMachine(id) : null;
  return machine ? defaultDiskGib(machine) : null;
}

export function machineLabel(machine: Pick<JobMachine, "kind" | "size">) {
  return machine.kind === "gpu" ? `GPU ${machine.size}` : `CPU ${machine.size}`;
}

export function profileIdLabel(id: string | null | undefined, templates: ContainerTemplate[] = []) {
  if (!id) return "Not recorded";
  const machine = findMachine(id);
  if (machine) return machineLabel(machine);
  if (legacyProfileLabels[id]) return legacyProfileLabels[id];
  const template = templates.find((item) => `local-template:${item.id}` === id);
  if (template) return template.label;
  if (id.startsWith("local-template:")) return "Local container template";
  return id;
}

export function environmentLabel(job: EnvironmentJob, templates: ContainerTemplate[] = []) {
  const machine = jobMachine(job);
  if (machine) return machineLabel(machine);
  return profileIdLabel(jobProfileId(job), templates);
}

export function gpuText(gpu: NonNullable<JobMachine["gpu"]>) {
  return `${gpu.count > 1 ? `${gpu.count}× ` : ""}${gpu.model} · ${gpu.memoryGib} GiB VRAM`;
}

/** "4 vCPU · 16 GiB RAM · NVIDIA L4 · 24 GiB VRAM · 50 GiB disk" */
export function machineSpecs(machine: JobMachine, diskGib?: number | null) {
  const parts = [`${machine.vcpu} vCPU`, `${machine.memoryGib} GiB RAM`, machine.gpu ? gpuText(machine.gpu) : "no GPU"];
  if (typeof diskGib === "number") parts.push(`${diskGib} GiB disk`);
  return parts.join(" · ");
}

export function usd(value: number) {
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

export function isActive(job: EnvironmentJob) {
  return job.state !== "stopped";
}

export function isProvisioning(job: EnvironmentJob) {
  return ["queued", "allocating", "connecting", "verifying"].includes(job.state);
}

/** Live state for summaries: a stop request counts as stopping before the worker confirms it. */
export function liveState(job: EnvironmentJob): "ready" | "provisioning" | "stopping" | "failed" | "stopped" {
  if (job.state === "stopped") return "stopped";
  if (job.state === "failed") return "failed";
  if (job.stop_requested_at || job.state === "stopping") return "stopping";
  if (job.state === "ready") return "ready";
  return "provisioning";
}

export const liveStateLabel = {
  ready: "ready",
  provisioning: "provisioning",
  stopping: "stopping",
  failed: "failed",
  stopped: "stopped",
} as const;

export function expiresAt(job: EnvironmentJob) {
  return Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
}

/** "45 min left", "1 h 20 min left", or "past its limit" for an active job. */
export function timeLeft(job: EnvironmentJob, now: number) {
  const end = expiresAt(job);
  if (!Number.isFinite(end)) return "limit not recorded";
  const minutes = Math.ceil((end - now) / 60_000);
  if (minutes <= 0) return "past its time limit";
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

/** "github.com/org/repo" from a repository URL. */
export function repoName(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}
