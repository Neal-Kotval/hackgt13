"use client";
import { Select } from "@/components/ui/select";

import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  CheckCircle,
  Clock,
  Database,
  HardDrives,
  Lightning,
  Plus,
  Minus,
  ShieldWarning,
  Warning,
} from "@phosphor-icons/react";
import type {
  Project,
  ResourceDefinition,
  ResourceKind,
  ResourceRequest,
  ResourceStatus,
} from "@/lib/types";
import { demoGpuDurations, demoGpuProfile, localDockerSandboxProfile, runpodGpuProfile, runpodGpuProfiles } from "@/lib/resource-profiles";
import { runBoxHardwareLabel } from "./run-box-label";
import "./resources.css";

type ResourceAction = (input: Record<string, unknown>) => Promise<unknown>;
type ResourceProps = { project: Project; onAction: ResourceAction };
type RunBoxJob = {
  id: string;
  resource_request_id: string;
  provider: "aws-ec2" | "runpod" | "docker-local";
  state: "queued" | "allocating" | "connecting" | "verifying" | "ready" | "stopping" | "stopped" | "failed";
  provider_resource_id: string | null;
  profile_id?: string | null;
  max_duration_minutes: number;
  stop_requested_at: string | null;
  created_at: string;
};

const gpuProfileLabels: Record<string, string> = {
  ...Object.fromEntries(runpodGpuProfiles.map((profile) => [profile.id, profile.label])),
  [demoGpuProfile.id]: `AWS EC2 · ${demoGpuProfile.label}`,
};

const resourceKinds: { value: ResourceKind; label: string }[] = [
  { value: "run-box", label: "Run box" },
  { value: "gpu", label: "GPU" },
  { value: "data-source", label: "Data source" },
  { value: "service", label: "Service" },
  { value: "inference-api", label: "Inference API" },
];

function kindLabel(kind: ResourceKind) {
  return resourceKinds.find((entry) => entry.value === kind)?.label ?? kind;
}

function readableDate(value?: string) {
  if (!value) return "No timestamp recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function statusDescription(status: ResourceStatus) {
  switch (status) {
    case "draft":
      return "Configuration only. No service has been deployed.";
    case "registered":
      return "Saved in the local catalog. Availability has not been checked.";
    case "verified":
      return "Marked verified in the record. Verification evidence is not available in this local catalog.";
    case "unavailable":
      return "This resource is not currently available.";
  }
}

function ResourceSymbol({ kind }: { kind: ResourceKind }) {
  const icon =
    kind === "gpu" ? (
      <Lightning />
    ) : kind === "data-source" ? (
      <Database />
    ) : kind === "inference-api" ? (
      <ArrowRight />
    ) : (
      <HardDrives />
    );
  return (
    <span className="resource-symbol" aria-hidden="true">
      {icon}
    </span>
  );
}

function ResourceBadge({ status }: { status: ResourceStatus }) {
  return (
    <span className={`resource-badge resource-badge--${status}`}>{status}</span>
  );
}

function FormFeedback({ error, success }: { error: string; success: string }) {
  return (
    <>
      {error && (
        <p className="resource-feedback resource-feedback--error" role="alert">
          <Warning />
          {error}
        </p>
      )}
      {success && (
        <p
          className="resource-feedback resource-feedback--success"
          role="status"
        >
          <CheckCircle />
          {success}
        </p>
      )}
    </>
  );
}

export function ResourceCatalog({ project, onAction }: ResourceProps) {
  const resources = project.resources ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ResourceKind>("run-box");
  const [capability, setCapability] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const selected =
    resources.find((item) => item.id === selectedId) ?? resources[0];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = (await onAction({
        type: "registerResource",
        projectId: project.id,
        name: name.trim(),
        kind,
        capability: capability.trim(),
        owner: owner.trim(),
      })) as { resource?: ResourceDefinition } | null;
      if (!response)
        throw new Error("The server did not confirm the registration.");
      if (response.resource?.id) setSelectedId(response.resource.id);
      setName("");
      setCapability("");
      setOwner("");
      setShowForm(false);
      setSuccess(
        "Resource registered. Connection and availability remain unverified.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not register resource.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="resource-page" aria-labelledby="resource-catalog-title">
      <div className="resource-page-heading">
        <div>
          <p className="resource-eyebrow">Project inventory</p>
          <h2 id="resource-catalog-title">Resources</h2>
          <p>
            Record intended compute, data, and service resources. Registration
            does not connect a box or verify a capability.
          </p>
        </div>
        <button
          className="button primary"
          type="button"
          onClick={() => setShowForm((value) => !value)}
          aria-expanded={showForm}
          aria-controls="resource-register-form"
        >
          {showForm ? <Minus aria-hidden="true" /> : <Plus aria-hidden="true" />} {showForm ? "Close form" : "Register resource"}
        </button>
      </div>
      <FormFeedback error={error} success={success} />
      {showForm && (
        <form
          id="resource-register-form"
          className="resource-form resource-panel"
          onSubmit={submit}
        >
          <div>
            <h3>Register a resource</h3>
            <p className="resource-note">
              This saves a catalog record only. It does not allocate, connect,
              or verify the resource.
            </p>
          </div>
          <div className="resource-form-grid">
            <label>
              Name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Descriptive resource name"
              />
            </label>
            <label>
              <span className="visually-hidden">Type</span>
              <Select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as ResourceKind)
                }
              >
                {resourceKinds
                  .filter((entry) => entry.value !== "inference-api")
                  .map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.label}
                    </option>
                  ))}
              </Select>
            </label>
            <label>
              Capability
              <input
                required
                maxLength={500}
                value={capability}
                onChange={(event) => setCapability(event.target.value)}
                placeholder="What this resource is intended to provide"
              />
            </label>
            <label>
              Recorded owner
              <input
                required
                maxLength={100}
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="Team or person responsible"
              />
            </label>
          </div>
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Registering…" : "Save registration"}
          </button>
        </form>
      )}
      {resources.length === 0 ? (
        <div className="resource-empty resource-panel">
          <HardDrives aria-hidden="true" />
          <h3>No resources registered</h3>
          <p>
            There is no known compute, data source, or service for this project.
            Register an intended resource to start an inventory.
          </p>
        </div>
      ) : (
        <div className="resource-layout">
          <div
            className="resource-list"
            role="list"
            aria-label="Project resources"
          >
            {resources.map((resource) => (
              <div
                className="resource-list-row"
                role="listitem"
                key={resource.id}
              >
                <button
                  className={`resource-card${selected?.id === resource.id ? " resource-card--selected" : ""}`}
                  type="button"
                  onClick={() => setSelectedId(resource.id)}
                  aria-pressed={selected?.id === resource.id}
                >
                  <ResourceSymbol kind={resource.kind} />
                  <span className="resource-card-copy">
                    <strong>{resource.name}</strong>
                    <span>
                      {kindLabel(resource.kind)} · {resource.owner}
                    </span>
                  </span>
                  <ResourceBadge status={resource.status} />
                </button>
              </div>
            ))}
          </div>
          {selected && <ResourceDetail resource={selected} />}
        </div>
      )}
    </section>
  );
}

function ResourceDetail({ resource }: { resource: ResourceDefinition }) {
  return (
    <section
      className="resource-detail resource-panel"
      aria-labelledby="resource-detail-title"
    >
      <p className="resource-eyebrow">Resource record</p>
      <div className="resource-detail-title">
        <h3 id="resource-detail-title">{resource.name}</h3>
        <ResourceBadge status={resource.status} />
      </div>
      <p className="resource-state-explanation">
        {statusDescription(resource.status)}
      </p>
      <dl className="resource-facts">
        <div>
          <dt>Type</dt>
          <dd>{kindLabel(resource.kind)}</dd>
        </div>
        <div>
          <dt>Capability</dt>
          <dd>{resource.capability}</dd>
        </div>
        <div>
          <dt>Recorded owner</dt>
          <dd>{resource.owner}</dd>
        </div>
        <div>
          <dt>Availability</dt>
          <dd>
            {resource.status === "verified"
              ? "Marked verified; evidence unavailable"
              : "Not verified available"}
          </dd>
        </div>
        <div>
          <dt>Last updated</dt>
          <dd>{readableDate(resource.updatedAt)}</dd>
        </div>
      </dl>
      {resource.inference && (
        <div className="resource-inference-summary">
          <h4>Inference configuration draft</h4>
          <p>
            {resource.inference.model} · {resource.inference.hardware}
          </p>
          <p>
            Scope: {resource.inference.accessScope} · Lifetime:{" "}
            {resource.inference.lifetime}
          </p>
        </div>
      )}
      {resource.status !== "verified" && (
        <p className="resource-caution">
          <ShieldWarning />
          No provider connection or execution evidence is attached to this
          record.
        </p>
      )}
    </section>
  );
}

export function ResourceRequests({ project, onAction }: ResourceProps) {
  const resources = project.resources ?? [];
  const requests = [...(project.resourceRequests ?? [])].reverse();
  const [formOpen, setFormOpen] = useState(false);
  const [resourceId, setResourceId] = useState("");
  const [kind, setKind] = useState<ResourceKind>("gpu");
  const [taskId, setTaskId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [purpose, setPurpose] = useState("");
  const [durationHours, setDurationHours] = useState<number>(2);
  const [gpuProfileId, setGpuProfileId] = useState<string>(runpodGpuProfile.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [jobs, setJobs] = useState<RunBoxJob[]>([]);
  const [projectRole, setProjectRole] = useState<"owner" | "member" | null>(null);
  const [jobBusy, setJobBusy] = useState("");
  const [jobError, setJobError] = useState("");
  const [jobSuccess, setJobSuccess] = useState("");
  const selectedResource = resources.find(
    (resource) => resource.id === resourceId,
  );

  useEffect(() => {
    let active = true;
    async function refreshJobs() {
      const [employeeResponse, jobsResponse] = await Promise.all([
        fetch("/api/employee"),
        fetch(`/api/run-boxes?projectId=${encodeURIComponent(project.id)}`),
      ]);
      if (!employeeResponse.ok || !jobsResponse.ok) throw new Error("Could not load run-box status.");
      const employee = await employeeResponse.json() as { memberships: { projectId: string; role: "owner" | "member" }[] };
      const data = await jobsResponse.json() as { jobs: RunBoxJob[] };
      if (active) {
        setProjectRole(employee.memberships.find((item) => item.projectId === project.id)?.role ?? null);
        setJobs(data.jobs);
        setJobError("");
      }
    }
    refreshJobs().catch((caught) => { if (active) setJobError(caught instanceof Error ? caught.message : "Could not load run-box status."); });
    const timer = window.setInterval(() => {
      refreshJobs().catch((caught) => { if (active) setJobError(caught instanceof Error ? caught.message : "Could not load run-box status."); });
    }, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [project.id]);

  async function decideRunBox(resourceRequestId: string) {
    setJobBusy(resourceRequestId);
    setJobError("");
    setJobSuccess("");
    try {
      const response = await fetch("/api/run-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, resourceRequestId, idempotencyKey: `gpu-${resourceRequestId}` }),
      });
      const data = await response.json() as { job?: RunBoxJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error || "GPU approval was not saved.");
      setJobs((current) => [{ ...data.job!, resource_request_id: resourceRequestId }, ...current.filter((job) => job.id !== data.job!.id)]);
      setJobSuccess("GPU job approved and queued. The worker may launch a billable GPU box.");
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : "Could not approve GPU job.");
    } finally { setJobBusy(""); }
  }

  async function stopRunBox(job: RunBoxJob) {
    setJobBusy(job.id);
    setJobError("");
    setJobSuccess("");
    try {
      const response = await fetch(`/api/run-boxes/${encodeURIComponent(job.id)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = await response.json() as { job?: RunBoxJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error || "Stop request was not saved.");
      setJobs((current) => current.map((item) => item.id === job.id ? { ...data.job!, resource_request_id: item.resource_request_id } : item));
      setJobSuccess("Stop requested. Wait for confirmed termination before treating this box as released.");
    } catch (caught) {
      setJobError(caught instanceof Error ? caught.message : "Could not request a stop.");
    } finally { setJobBusy(""); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = (await onAction({
        type: "requestResource",
        projectId: project.id,
        ...(resourceId ? { resourceId } : {}),
        kind: selectedResource?.kind ?? kind,
        ...(taskId ? { taskId } : {}),
        ...(agentId ? { agentId } : {}),
        purpose: purpose.trim(),
        ...(!resourceId && kind === "gpu"
          ? {
              gpuProfileId,
              durationHours,
            }
          : {}),
      })) as { request?: ResourceRequest } | null;
      if (!response?.request?.id)
        throw new Error("The server did not confirm the request.");
      setPurpose("");
      setSuccess(
        "Request saved. No policy decision or allocation has occurred.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save request.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="resource-page"
      aria-labelledby="resource-requests-title"
    >
      <div className="resource-page-heading">
        <div>
          <p className="resource-eyebrow">Access and allocation</p>
          <h2 id="resource-requests-title">Requests</h2>
          <p>
            Save a resource request, then approve a bounded run box. The worker
            reports allocation and cleanup separately.
          </p>
        </div>
        <button
          className="button secondary"
          type="button"
          aria-expanded={formOpen}
          aria-controls="resource-request-form"
          onClick={() => setFormOpen((open) => !open)}
        >
          {formOpen ? "Close request form" : "New request"}
        </button>
      </div>
      <div className={`resource-request-layout${formOpen ? "" : " history-only"}`}>
        {formOpen && <form id="resource-request-form" className="resource-form resource-panel" onSubmit={submit}>
          <div>
            <h3>New request</h3>
              <p className="resource-note">
                Saving a request does not start a machine. Project owners can
                approve a run box from the request history.
            </p>
          </div>
          <label>
            <span>Catalog resource</span>
            <Select
              value={resourceId}
              onChange={(event) => setResourceId(event.target.value)}
            >
              <option value="">No specific resource</option>
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name} ({resource.status})
                </option>
              ))}
            </Select>
          </label>
          {!resourceId && (
            <label>
              <span>Resource type</span>
              <Select
                value={kind}
                onChange={(event) =>
                  setKind(event.target.value as ResourceKind)
                }
              >
                {resourceKinds.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {!resourceId && kind === "gpu" && (
            <div className="resource-price-summary">
              <label>
                <span>GPU provider and profile</span>
                <Select value={gpuProfileId} onChange={(event) => setGpuProfileId(event.target.value)}>
                  <option value={runpodGpuProfile.id}>
                    {runpodGpuProfile.label}
                  </option>
                  <option value={demoGpuProfile.id}>
                    AWS EC2 · {demoGpuProfile.label} (paid AWS account required)
                  </option>
                </Select>
              </label>
              <label>
                <span>Requested duration</span>
                <Select
                  value={durationHours}
                  onChange={(event) =>
                    setDurationHours(Number(event.target.value))
                  }
                >
                  {demoGpuDurations.map((hours) => (
                    <option key={hours} value={hours}>
                      {hours} {hours === 1 ? "hour" : "hours"}
                    </option>
                  ))}
                </Select>
              </label>
              {gpuProfileId === runpodGpuProfile.id ? (
                <>
                  <dl className="resource-facts resource-facts--compact">
                    <div><dt>GPU</dt><dd>{runpodGpuProfile.gpuId}</dd></div>
                    <div><dt>Rate limit</dt><dd>Up to ${runpodGpuProfile.maxHourlyUsd.toFixed(2)}/hour; live price checked before launch</dd></div>
                  </dl>
                  <p className="resource-note">Runpod Secure Cloud charges for compute and storage. The worker checks live availability and price before creating a Pod, then terminates it at stop or expiry. No Pod starts when you save this request.</p>
                </>
              ) : (<>
              <dl className="resource-facts resource-facts--compact">
                <div>
                  <dt>Compute rate</dt>
                  <dd>${demoGpuProfile.hourlyComputeUsd.toFixed(4)}/hour</dd>
                </div>
                <div>
                  <dt>Compute estimate</dt>
                  <dd>
                    $
                    {(demoGpuProfile.hourlyComputeUsd * durationHours).toFixed(
                      2,
                    )}{" "}
                    for {durationHours} {durationHours === 1 ? "hour" : "hours"}
                  </dd>
                </div>
              </dl>
              <p className="resource-note">
                AWS Price List quote from {demoGpuProfile.quotedAt} for{" "}
                {demoGpuProfile.region}. Excludes storage, public IPv4,
                transfer, and taxes. Quota, price, credit, and capacity are
                checked again before launch. Approval may incur charges.
              </p>
              </>)}
            </div>
          )}
          <label>
            <span>Task</span>
            <Select
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">No task selected</option>
              {project.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span>Agent</span>
            <Select
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">No agent selected</option>
              {project.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} · {agent.role}
                </option>
              ))}
            </Select>
          </label>
          <label>
            Purpose
            <textarea
              required
              maxLength={1000}
              rows={3}
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
              placeholder="What work requires this resource?"
            />
          </label>
          <FormFeedback error={error} success={success} />
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Saving request…" : "Save request"}
          </button>
        </form>}
        <section
          className="resource-request-history"
          aria-label="Resource request history"
        >
          <FormFeedback error={jobError} success={jobSuccess} />
          <h3>
            Request history{" "}
            <span className="resource-count">{requests.length}</span>
          </h3>
          {requests.length === 0 ? (
            <div className="resource-empty resource-panel">
              <Clock aria-hidden="true" />
              <h4>No requests yet</h4>
              <p>
                Create a request to record the needed resource and purpose. No
                capacity is reserved by this form.
              </p>
            </div>
          ) : (
            requests.map((request) => (
              <RequestCard
                key={request.id}
                project={project}
                request={request}
                job={jobs.find((item) => item.resource_request_id === request.id)}
                projectRole={projectRole}
                busy={jobBusy}
                onApprove={decideRunBox}
                onStop={stopRunBox}
              />
            ))
          )}
        </section>
      </div>
    </section>
  );
}

function RequestCard({
  request,
  project,
  job,
  projectRole,
  busy,
  onApprove,
  onStop,
}: {
  request: ResourceRequest;
  project: Project;
  job?: RunBoxJob;
  projectRole: "owner" | "member" | null;
  busy: string;
  onApprove: (resourceRequestId: string) => Promise<void>;
  onStop: (job: RunBoxJob) => Promise<void>;
}) {
  const resource = (project.resources ?? []).find(
    (entry) => entry.id === request.resourceId,
  );
  const task = project.tasks.find((entry) => entry.id === request.taskId);
  const agent = project.agents.find((entry) => entry.id === request.agentId);
  const decision = request.decision;
  return (
    <article className="resource-request-card resource-panel">
      <div className="resource-detail-title">
        <h4>{resource?.name ?? kindLabel(request.kind)}</h4>
        <span className={`resource-badge resource-badge--${request.status}`}>
          {request.status}
        </span>
      </div>
      <p>{request.purpose}</p>
      <dl className="resource-facts resource-facts--compact">
        {request.computePreference && (
          <div>
            <dt>{request.computePreference.provider === "docker-local" ? "Environment plan" : "GPU plan"}</dt>
            {request.computePreference.provider === "docker-local" ? (
              <dd>{localDockerSandboxProfile.label} · no GPU, no provider cost · {request.computePreference.durationHours} {request.computePreference.durationHours === 1 ? "hour" : "hours"}</dd>
            ) : request.computePreference.provider === "runpod" ? (
              <dd>{request.computePreference.gpuId} · Runpod Secure Cloud · up to ${request.computePreference.maxHourlyUsd.toFixed(2)}/hour for {request.computePreference.durationHours} {request.computePreference.durationHours === 1 ? "hour" : "hours"}; live price pending</dd>
            ) : (
              <dd>{request.computePreference.instanceType} · ${request.computePreference.estimatedComputeUsd.toFixed(2)} compute for {request.computePreference.durationHours} {request.computePreference.durationHours === 1 ? "hour" : "hours"} (quote {request.computePreference.quotedAt})</dd>
            )}
          </div>
        )}
        <div>
          <dt>Task</dt>
          <dd>{task?.title ?? "Not linked"}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{agent?.name ?? "Not linked"}</dd>
        </div>
        <div>
          <dt>Requested</dt>
          <dd>{readableDate(request.createdAt)}</dd>
        </div>
      </dl>
      <div
        className={`resource-decision resource-decision--${job ? "approved" : decision.status}`}
      >
        <ShieldWarning aria-hidden="true" />
        <div>
          <strong>Permission: {job ? "approved" : decision.status.replace("_", " ")}</strong>
          <p>{job ? "A project owner approved this run box. Allocation and readiness are shown below." : decision.reason}</p>
        </div>
      </div>
      {job ? (
        <div className="resource-job">
          <div className="resource-detail-title">
            <h4>Run box</h4>
            <span className={`resource-badge resource-badge--${job.state}`}>
              {job.state}
            </span>
          </div>
          <p className="resource-note">{runBoxHardwareLabel(job, gpuProfileLabels)}</p>
          <dl className="resource-facts resource-facts--compact">
            <div><dt>Provider</dt><dd>{job.provider === "runpod" ? "Runpod" : job.provider === "docker-local" ? "Local Docker" : "AWS EC2"}{job.provider_resource_id ? ` · ${job.provider_resource_id}` : " · not allocated"}</dd></div>
            <div><dt>Approved limit</dt><dd>{job.max_duration_minutes} minutes</dd></div>
            <div><dt>Cleanup</dt><dd>{job.state === "stopped" ? job.provider_resource_id ? `${job.provider === "runpod" ? "Pod" : job.provider === "docker-local" ? "Container" : "EC2"} release confirmed by worker` : "Cancelled before allocation" : job.stop_requested_at ? "Stop requested; awaiting confirmation" : "Not requested"}</dd></div>
          </dl>
          {job.provider === "runpod" && job.state === "allocating" && !job.provider_resource_id && (
            <p className="resource-note">Checking Runpod setup, live price, and the independent cleanup guard before creating a Pod.</p>
          )}
          {job.provider === "runpod" && ["connecting", "verifying"].includes(job.state) && (
            <p className="resource-note">SSH identity, workspace, and GPU workload verification are in progress.</p>
          )}
          {projectRole === "owner" && job.state !== "stopped" && !job.stop_requested_at && (
            <button className="button danger" type="button" disabled={Boolean(busy)} onClick={() => void onStop(job)}>
              {busy === job.id ? "Requesting stop…" : "Request stop"}
            </button>
          )}
          {job.state === "failed" && <p className="resource-note">The job failed. Check worker evidence and request cleanup before trying again.</p>}
        </div>
      ) : request.kind === "gpu" && request.computePreference && request.computePreference.provider !== "docker-local" && projectRole === "owner" ? (
        <div className="resource-job">
          {request.computePreference.provider === "runpod" ? (
            <p className="resource-note">Approving this request queues a Runpod GPU Pod for up to {request.computePreference.durationHours} {request.computePreference.durationHours === 1 ? "hour" : "hours"}. The worker must confirm availability and a live compute price at or below ${request.computePreference.maxHourlyUsd.toFixed(2)}/hour before launch. Storage and taxes may add cost.</p>
          ) : (
            <p className="resource-note">Approving this request queues an AWS GPU launch for up to {request.computePreference.durationHours} {request.computePreference.durationHours === 1 ? "hour" : "hours"}. Compute is quoted at ${request.computePreference.estimatedComputeUsd.toFixed(2)} before storage, network, and tax. The worker must pass live cost and safety checks before launch.</p>
          )}
          <button className="button success" type="button" disabled={Boolean(busy)} onClick={() => void onApprove(request.id)}>
            {busy === request.id ? "Approving…" : "Approve and queue GPU"}
          </button>
        </div>
      ) : request.status === "requested" && (
        <p className="resource-note">
          No resource has been allocated or started. A project owner must approve a run box.
        </p>
      )}
    </article>
  );
}

export function InferenceDraft({ project, onAction }: ResourceProps) {
  const drafts = (project.resources ?? []).filter(
    (resource) => resource.kind === "inference-api",
  );
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [hardware, setHardware] = useState("");
  const [accessScope, setAccessScope] = useState("Project agents");
  const [lifetime, setLifetime] = useState("One run");
  const [owner, setOwner] = useState("");
  const [capability, setCapability] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const response = (await onAction({
        type: "saveInferenceDraft",
        projectId: project.id,
        name: name.trim(),
        capability: capability.trim(),
        owner: owner.trim(),
        inference: {
          model: model.trim(),
          hardware: hardware.trim(),
          accessScope,
          lifetime,
        },
      })) as { resource?: ResourceDefinition } | null;
      if (!response?.resource?.id)
        throw new Error("The server did not confirm the draft.");
      setName("");
      setModel("");
      setHardware("");
      setOwner("");
      setCapability("");
      setSuccess(
        "Configuration draft saved. No inference service was deployed.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save configuration draft.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="resource-page" aria-labelledby="inference-title">
      <div className="resource-page-heading">
        <div>
          <p className="resource-eyebrow">Planned service resource</p>
          <h2 id="inference-title">Inference API</h2>
          <p>
            Capture a desired model endpoint configuration. Serving, private
            access, and GPU allocation require a future provider.
          </p>
        </div>
      </div>
      <div className="resource-inference-banner">
        <ShieldWarning />
        <div>
          <strong>Deployment unavailable</strong>
          <p>
            A saved draft does not start a model, reserve hardware, expose an
            endpoint, or enforce access scope.
          </p>
        </div>
      </div>
      <div className="resource-request-layout">
        <form className="resource-form resource-panel" onSubmit={submit}>
          <h3>New configuration draft</h3>
          <div className="resource-form-grid">
            <label>
              Name
              <input
                required
                maxLength={100}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Endpoint draft name"
              />
            </label>
            <label>
              Model
              <input
                required
                maxLength={200}
                value={model}
                onChange={(event) => setModel(event.target.value)}
                placeholder="Model identifier and version"
              />
            </label>
            <label>
              Hardware
              <input
                required
                maxLength={200}
                value={hardware}
                onChange={(event) => setHardware(event.target.value)}
                placeholder="Desired GPU or capacity"
              />
            </label>
            <label>
              Recorded owner
              <input
                required
                maxLength={100}
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="Team or person responsible"
              />
            </label>
            <label>
              <span className="visually-hidden">Access scope</span>
              <Select
                value={accessScope}
                onChange={(event) => setAccessScope(event.target.value)}
              >
                <option>Project agents</option>
                <option>Project members</option>
                <option>Named identities</option>
              </Select>
              <small>Intent only; no access rule is enforced.</small>
            </label>
            <label>
              <span className="visually-hidden">Lifetime</span>
              <Select
                value={lifetime}
                onChange={(event) => setLifetime(event.target.value)}
              >
                <option>One run</option>
                <option>Project session</option>
                <option>Persistent service</option>
              </Select>
              <small>Intent only; no expiry is enforced.</small>
            </label>
          </div>
          <label>
            Intended capability
            <textarea
              required
              maxLength={500}
              rows={2}
              value={capability}
              onChange={(event) => setCapability(event.target.value)}
              placeholder="What should consuming agents use this endpoint for?"
            />
          </label>
          <FormFeedback error={error} success={success} />
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? "Saving draft…" : "Save configuration draft"}
          </button>
        </form>
        <section
          className="resource-request-history"
          aria-label="Inference drafts"
        >
          <h3>
            Saved configurations{" "}
            <span className="resource-count">{drafts.length}</span>
          </h3>
          {drafts.length === 0 ? (
            <div className="resource-empty resource-panel">
              <Lightning aria-hidden="true" />
              <h4>No inference drafts</h4>
              <p>
                Configuration plans will appear here after you save one.
                Deployment is not available.
              </p>
            </div>
          ) : (
            drafts.map((draft) => (
              <article
                key={draft.id}
                className="resource-request-card resource-panel"
              >
                <div className="resource-detail-title">
                  <h4>{draft.name}</h4>
                  <ResourceBadge status={draft.status} />
                </div>
                <p>{draft.capability}</p>
                <dl className="resource-facts resource-facts--compact">
                  <div>
                    <dt>Model</dt>
                    <dd>{draft.inference?.model ?? "Not specified"}</dd>
                  </div>
                  <div>
                    <dt>Hardware</dt>
                    <dd>{draft.inference?.hardware ?? "Not specified"}</dd>
                  </div>
                  <div>
                    <dt>Access intent</dt>
                    <dd>{draft.inference?.accessScope ?? "Not specified"}</dd>
                  </div>
                  <div>
                    <dt>Lifetime intent</dt>
                    <dd>{draft.inference?.lifetime ?? "Not specified"}</dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{draft.owner}</dd>
                  </div>
                </dl>
                <p className="resource-note">
                  No deployed endpoint or verified GPU allocation.
                </p>
              </article>
            ))
          )}
        </section>
      </div>
    </section>
  );
}
