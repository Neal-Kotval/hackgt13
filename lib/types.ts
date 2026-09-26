export type TaskStatus = "queued" | "in progress" | "blocked" | "done";
export interface Agent {
  id: string;
  name: string;
  role: string;
  client: string;
  branch: string;
  status: string;
  lastSeen?: string;
}
export interface Task {
  id: string;
  title: string;
  owner: string;
  status: TaskStatus;
  dependency?: string;
  handoffId?: string;
  /** Authoring body from desktop; optional for legacy tasks. */
  instructions?: string;
  /** Verified resource/environment bound at create time; optional. */
  environmentId?: string;
}
export interface Service {
  id: string;
  name: string;
  url: string;
  owner: string;
  consumers: string[];
  status: string;
}
export interface Handoff {
  id: string;
  from: string;
  to: string;
  title: string;
  summary: string;
  files: string[];
  next: string;
  accepted: boolean;
}
export interface Activity {
  id: string;
  time: string;
  actor: string;
  text: string;
  kind: string;
  detail?: string;
}
export type ResourceKind =
  "run-box" | "gpu" | "data-source" | "service" | "inference-api";
export type ResourceStatus =
  "draft" | "registered" | "verified" | "unavailable";
export interface InferenceConfiguration {
  model: string;
  hardware: string;
  accessScope: string;
  lifetime: string;
}
export interface ResourceDefinition {
  id: string;
  name: string;
  kind: ResourceKind;
  capability: string;
  owner: string;
  status: ResourceStatus;
  createdAt: string;
  updatedAt: string;
  inference?: InferenceConfiguration;
}
export type ResourceRequestStatus =
  | "requested"
  | "approved"
  | "allocated"
  | "running"
  | "verified"
  | "denied"
  | "unavailable";
export interface ResourceRequest {
  id: string;
  resourceId?: string;
  kind: ResourceKind;
  taskId?: string;
  agentId?: string;
  purpose: string;
  requestedBy?: {
    employeeId: string;
    organizationId: string;
    projectRoleAtRequest: "owner" | "member";
  };
  computePreference?: {
    provider: "aws-ec2";
    profileId: string;
    region: string;
    instanceType: string;
    durationHours: number;
    estimatedComputeUsd: number;
    quotedAt: string;
  } | {
    provider: "runpod";
    profileId: string;
    gpuId: string;
    cloud: "SECURE";
    durationHours: number;
    maxHourlyUsd: number;
  };
  status: ResourceRequestStatus;
  decision: {
    status: "not_evaluated" | "approved" | "denied";
    reason: string;
  };
  createdAt: string;
}
export interface Project {
  id: string;
  name: string;
  repo: string;
  template: string;
  compute: string;
  host?: string;
  agents: Agent[];
  tasks: Task[];
  services: Service[];
  handoffs: Handoff[];
  events: Activity[];
  resources: ResourceDefinition[];
  resourceRequests: ResourceRequest[];
  createdAt: string;
}
export interface State {
  projects: Project[];
  revision: number;
}
