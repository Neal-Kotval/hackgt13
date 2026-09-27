"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  CheckCircle,
  Copy,
  Cube,
  Desktop,
  Lightning,
  Plus,
  ShieldWarning,
  Stop,
  Warning,
} from "@phosphor-icons/react";
import type { Project } from "@/lib/types";
import {
  demoGpuDurations,
  demoGpuProfile,
  localDockerSandboxProfile,
  runpodBudgetGpuProfile,
  runpodGpuProfile,
} from "@/lib/resource-profiles";
import "../resources/resources.css";
import "./environments.css";

type JobState =
  | "queued"
  | "allocating"
  | "connecting"
  | "verifying"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

// Shape of GET /api/run-boxes?projectId= (docs/sandbox-mvp-contract.md). The
// profileId, ssh, desktopUrl, and access fields are optional until the listing
// extension lands; the page never invents them.
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
  created_at: string;
  outcome?: "approved" | "denied";
  decision_reason?: string;
  failure_reason?: string | null;
  failureReason?: string | null;
  ssh?: { host: string; port: number; username?: string } | null;
  desktopUrl?: string | null;
  access?: "trusted-shell";
};

type Role = "owner" | "member" | null;

const profiles = [
  {
    id: localDockerSandboxProfile.id,
    label: localDockerSandboxProfile.label,
    icon: <Cube aria-hidden="true" />,
    summary: "CPU-only Linux container · no GPU · no provider cost",
    detail:
      "Runs with sshd on the machine that runs the AgentCloud worker. Suitable for local development and demos. It has no GPU.",
  },
  {
    id: runpodBudgetGpuProfile.id,
    label: "Runpod budget GPU",
    icon: <Lightning aria-hidden="true" />,
    summary: `RTX 2000 Ada, A5000, or 4000 Ada, whichever is in stock · up to $${runpodBudgetGpuProfile.maxHourlyUsd.toFixed(2)}/hour`,
    detail:
      "Billable, for short smoke tests. The worker checks live price and availability against the hourly ceiling before creating a Pod, and marks it ready only after an SSH and GPU probe succeeds.",
  },
  {
    id: runpodGpuProfile.id,
    label: "Runpod RTX 4090",
    icon: <Lightning aria-hidden="true" />,
    summary: `Runpod Secure Cloud · up to $${runpodGpuProfile.maxHourlyUsd.toFixed(2)}/hour`,
    detail:
      "Billable. The worker checks live price and availability against the hourly ceiling before creating a Pod, and marks it ready only after an SSH and GPU probe succeeds.",
  },
  {
    id: demoGpuProfile.id,
    label: "AWS EC2 g6 · NVIDIA L4",
    icon: <Lightning aria-hidden="true" />,
    summary: `SSM-managed ${demoGpuProfile.instanceType} · desktop SSH not yet available`,
    detail:
      "Billable on a paid AWS account. Managed through AWS Systems Manager; the GPU is verified by probe. Opening it in the desktop app over SSH is not available yet.",
  },
] as const;

const stateCopy: Record<JobState, { label: string; phase: string; detail: string }> = {
  queued: {
    label: "Queued",
    phase: "Requested",
    detail: "Approved and waiting for a worker. No machine exists yet.",
  },
  allocating: {
    label: "Allocating",
    phase: "Provisioning",
    detail: "A worker is checking limits and creating the environment.",
  },
  connecting: {
    label: "Connecting",
    phase: "Provisioning",
    detail: "The environment was allocated. The worker is establishing SSH access.",
  },
  verifying: {
    label: "Verifying",
    phase: "Provisioning",
    detail: "The worker is checking the pinned host key, workspace, and hardware.",
  },
  ready: {
    label: "Ready",
    phase: "Verified ready",
    detail: "The worker verified SSH access against the host key it generated for this environment.",
  },
  stopping: {
    label: "Stopping",
    phase: "Stopping",
    detail: "Stop requested. Waiting for the worker to confirm teardown.",
  },
  stopped: {
    label: "Stopped",
    phase: "Stopped",
    detail: "The worker recorded this environment as stopped.",
  },
  failed: {
    label: "Failed",
    phase: "Failed",
    detail: "The worker recorded a failure. Request a stop so it confirms cleanup.",
  },
};

function providerLabel(provider: EnvironmentJob["provider"]) {
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

function profileLabel(job: EnvironmentJob) {
  const id = job.profileId ?? job.profile_id;
  const known = profiles.find((profile) => profile.id === id);
  if (known) return known.label;
  if (job.provider === "aws-ec2") return profiles[2].label;
  return id || "Not recorded";
}

function readableDate(value: string | number) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
}

function sshCommand(ssh: NonNullable<EnvironmentJob["ssh"]>) {
  return `ssh -p ${ssh.port} ${ssh.username || "agentcloud"}@${ssh.host}`;
}

function newKey() {
  return `env-${crypto.randomUUID()}`;
}

export function Environments({ project }: { project: Project }) {
  const [jobs, setJobs] = useState<EnvironmentJob[] | null>(null);
  const [role, setRole] = useState<Role>(null);
  const [loadError, setLoadError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [profileId, setProfileId] = useState<string>(localDockerSandboxProfile.id);
  const [durationHours, setDurationHours] = useState<number>(1);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [confirmingStop, setConfirmingStop] = useState("");
  const [stopBusy, setStopBusy] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const formHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => setServerUrl(window.location.origin), []);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const [employeeResponse, jobsResponse] = await Promise.all([
        fetch("/api/employee"),
        fetch(`/api/run-boxes?projectId=${encodeURIComponent(project.id)}`),
      ]);
      if (!employeeResponse.ok || !jobsResponse.ok)
        throw new Error("Could not load environment status.");
      const employee = (await employeeResponse.json()) as {
        memberships: { projectId: string; role: "owner" | "member" }[];
      };
      const data = (await jobsResponse.json()) as { jobs: EnvironmentJob[] };
      if (!active) return;
      setRole(employee.memberships.find((item) => item.projectId === project.id)?.role ?? null);
      setJobs(data.jobs);
      setLoadError("");
    }
    const report = (caught: unknown) => {
      if (active)
        setLoadError(caught instanceof Error ? caught.message : "Could not load environment status.");
    };
    refresh().catch(report);
    const timer = window.setInterval(() => refresh().catch(report), 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project.id]);

  useEffect(() => {
    if (showForm) formHeading.current?.focus();
  }, [showForm]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    setNotice("");
    try {
      const response = await fetch("/api/run-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, profileId, durationHours, idempotencyKey }),
      });
      const data = (await response.json()) as {
        job?: EnvironmentJob | null;
        decision?: { outcome: "approved" | "denied"; reason: string; resource_request_id: string };
        error?: string;
      };
      if (!response.ok || !data.decision)
        throw new Error(data.error || "The environment request was not saved.");
      // A saved decision consumes this key; the next submission is a new request.
      setIdempotencyKey(newKey());
      if (data.decision.outcome === "denied" || !data.job) {
        setFormError(`Request recorded and denied: ${data.decision.reason}.`);
        return;
      }
      const job = { ...data.job, resource_request_id: data.decision.resource_request_id };
      setJobs((current) => [job, ...(current ?? []).filter((item) => item.id !== job.id)]);
      setShowForm(false);
      setNotice("Environment requested and queued. It is not usable until a worker verifies it ready.");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not request an environment.");
    } finally {
      setBusy(false);
    }
  }

  async function stop(job: EnvironmentJob) {
    setStopBusy(job.id);
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(`/api/run-boxes/${encodeURIComponent(job.id)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = (await response.json()) as { job?: EnvironmentJob; error?: string };
      if (!response.ok || !data.job) throw new Error(data.error || "Stop request was not saved.");
      setJobs((current) =>
        (current ?? []).map((item) => (item.id === job.id ? { ...item, ...data.job! } : item)),
      );
      setConfirmingStop("");
      setNotice("Stop requested. The environment is released only after the worker confirms teardown.");
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not request a stop.");
    } finally {
      setStopBusy("");
    }
  }

  async function copy(command: string) {
    setActionError("");
    try {
      await navigator.clipboard.writeText(command);
      setNotice("SSH command copied.");
    } catch {
      setActionError("Clipboard unavailable. Select the command to copy it.");
    }
  }

  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? profiles[0];
  const empty = jobs !== null && jobs.length === 0;

  return (
    <section className="resource-page" aria-labelledby="environments-title">
      <div className="resource-page-heading">
        <div>
          <p className="resource-eyebrow">Project compute</p>
          <h2 id="environments-title">Environments</h2>
          <p>
            Start a time-limited environment for this project, watch it move
            from requested to verified ready, then open it in the desktop app.
          </p>
        </div>
        {!empty && (
          <button
            className="button primary"
            type="button"
            onClick={() => setShowForm((value) => !value)}
            aria-expanded={showForm}
            aria-controls="environment-form"
          >
            <Plus aria-hidden="true" /> {showForm ? "Close form" : "New environment"}
          </button>
        )}
      </div>

      <div className="environment-live" role="status" aria-live="polite">
        {notice && (
          <p className="resource-feedback resource-feedback--success">
            <CheckCircle aria-hidden="true" />
            {notice}
          </p>
        )}
      </div>
      {(actionError || loadError) && (
        <p className="resource-feedback resource-feedback--error" role="alert">
          <Warning aria-hidden="true" />
          {actionError || loadError}
        </p>
      )}

      {empty && !showForm && (
        <div className="resource-empty resource-panel">
          <Cube aria-hidden="true" />
          <h3>No environments yet</h3>
          <p>
            An environment is a machine this project can use through trusted
            shell access. Nothing is running for this project.
          </p>
          <button
            className="button primary"
            type="button"
            onClick={() => setShowForm(true)}
            aria-expanded={showForm}
            aria-controls="environment-form"
          >
            <Plus aria-hidden="true" /> New environment
          </button>
        </div>
      )}

      {showForm && (
        <form
          id="environment-form"
          className="resource-form resource-panel environment-form"
          onSubmit={submit}
          aria-labelledby="environment-form-title"
        >
          <div>
            <h3 id="environment-form-title" ref={formHeading} tabIndex={-1}>
              New environment
            </h3>
            <p className="resource-note">
              {role === "member"
                ? "Only project owners can start environments. A member request is recorded and denied by policy."
                : "Submitting records a request and an owner approval, then queues one job. A worker must allocate and verify it before it is ready."}
            </p>
          </div>
          <fieldset className="environment-options">
            <legend>Profile</legend>
            {profiles.map((profile) => (
              <label
                key={profile.id}
                className={`compute-option environment-option${profileId === profile.id ? " chosen" : ""}`}
              >
                <input
                  type="radio"
                  name="environment-profile"
                  value={profile.id}
                  checked={profileId === profile.id}
                  onChange={() => setProfileId(profile.id)}
                />
                {profile.icon}
                <span>
                  <strong>{profile.label}</strong>
                  <small>{profile.summary}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="resource-note">{selectedProfile.detail}</p>
          <fieldset className="environment-durations">
            <legend>Duration</legend>
            <div className="environment-duration-row">
              {demoGpuDurations.map((hours) => (
                <label
                  key={hours}
                  className={`compute-option environment-duration${durationHours === hours ? " chosen" : ""}`}
                >
                  <input
                    type="radio"
                    name="environment-duration"
                    value={hours}
                    checked={durationHours === hours}
                    onChange={() => setDurationHours(hours)}
                  />
                  <strong>
                    {hours} {hours === 1 ? "hour" : "hours"}
                  </strong>
                </label>
              ))}
            </div>
            <small className="environment-hint">
              The worker stops the environment at this limit, counted from the request.
            </small>
          </fieldset>
          {formError && (
            <p className="resource-feedback resource-feedback--error" role="alert">
              <Warning aria-hidden="true" />
              {formError}
            </p>
          )}
          <div className="environment-actions">
            <button className="button primary" type="submit" disabled={busy}>
              {busy ? "Requesting…" : "Create environment"}
            </button>
            <button className="button" type="button" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {jobs === null && !loadError && <p className="resource-note">Loading environments…</p>}

      {jobs && jobs.length > 0 && (
        <section className="environment-list-section" aria-labelledby="environment-list-title">
          <h3 id="environment-list-title" className="environment-list-title">
            Project environments <span className="resource-count">{jobs.length}</span>
          </h3>
          <ul className="environment-list">
            {jobs.map((job) => (
              <EnvironmentCard
                key={job.id}
                job={job}
                projectId={project.id}
                serverUrl={serverUrl}
                role={role}
                confirming={confirmingStop === job.id}
                stopBusy={stopBusy === job.id}
                onConfirm={() => setConfirmingStop(job.id)}
                onCancel={() => setConfirmingStop("")}
                onStop={() => void stop(job)}
                onCopy={(command) => void copy(command)}
              />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function EnvironmentCard({
  job,
  projectId,
  serverUrl,
  role,
  confirming,
  stopBusy,
  onConfirm,
  onCancel,
  onStop,
  onCopy,
}: {
  job: EnvironmentJob;
  projectId: string;
  serverUrl: string;
  role: Role;
  confirming: boolean;
  stopBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onStop: () => void;
  onCopy: (command: string) => void;
}) {
  const copy = stateCopy[job.state] ?? stateCopy.failed;
  const confirmButton = useRef<HTMLButtonElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (wasConfirming.current) stopButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const titleId = `environment-${job.id}-title`;
  const failure = job.failureReason ?? job.failure_reason;
  const expiresAt = Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
  const command = job.ssh ? sshCommand(job.ssh) : "";
  const canStop = role === "owner" && job.state !== "stopped" && !job.stop_requested_at;
  const ready = job.state === "ready" && !job.stop_requested_at;
  const taskUrl = ready && serverUrl
    ? `agentcloud://open?${new URLSearchParams({ projectId, taskRunBoxId: job.id, serverUrl })}`
    : "";
  const terminalUrl = ready && serverUrl && job.ssh && job.desktopUrl
    ? `${job.desktopUrl}&${new URLSearchParams({ serverUrl })}`
    : "";
  const stopped = job.state === "stopped";
  const stopDetail =
    stopped && !job.provider_resource_id
      ? "Stopped before a machine was allocated."
      : copy.detail;

  return (
    <li className="resource-request-card resource-panel environment-card" aria-labelledby={titleId}>
      <div className="resource-detail-title">
        <div className="environment-title">
          <h4 id={titleId}>{profileLabel(job)}</h4>
          {copy.phase !== copy.label && <span className="environment-phase">{copy.phase}</span>}
        </div>
        <span className={`resource-badge resource-badge--${job.state}`}>{copy.label}</span>
      </div>
      <p className="resource-note">{stopDetail}</p>
      <dl className="resource-facts resource-facts--compact">
        <div>
          <dt>Provider</dt>
          <dd>
            {providerLabel(job.provider)}
            {job.provider_resource_id ? ` · ${job.provider_resource_id}` : " · not allocated"}
          </dd>
        </div>
        <div>
          <dt>Profile</dt>
          <dd>{job.profileId ?? job.profile_id ?? (job.provider === "aws-ec2" ? demoGpuProfile.id : "Not recorded")}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{readableDate(job.created_at)}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>
            {Number.isFinite(expiresAt) ? readableDate(expiresAt) : "Not recorded"} ·{" "}
            {job.max_duration_minutes / 60} {job.max_duration_minutes === 60 ? "hour" : "hours"} limit
          </dd>
        </div>
        {job.decision_reason && (
          <div>
            <dt>Decision</dt>
            <dd>{job.decision_reason}</dd>
          </div>
        )}
        {job.state === "failed" && (
          <div>
            <dt>Failure</dt>
            <dd>{failure || "No failure reason was recorded in this listing."}</dd>
          </div>
        )}
        {job.stop_requested_at && (
          <div>
            <dt>Stop requested</dt>
            <dd>{readableDate(job.stop_requested_at)}</dd>
          </div>
        )}
      </dl>

      <div className="environment-access">
        <p className="environment-trust">
          <ShieldWarning aria-hidden="true" />
          <span>
            <strong>Trusted shell access</strong> — SSH gives full shell access
            to this environment. It is not a filesystem or command sandbox.
          </span>
        </p>
        {job.ssh ? (
          <code className="environment-command" aria-label="SSH command">
            {command}
          </code>
        ) : (
          <p className="resource-note">
            {job.state === "ready"
              ? "No SSH endpoint is recorded for this environment."
              : ["stopping", "stopped", "failed"].includes(job.state)
                ? "No SSH access is offered for an environment in this state."
                : "An SSH endpoint appears after the worker records one."}
          </p>
        )}
      </div>

      <div className="environment-actions">
        {taskUrl && (
          <a className="button primary" href={taskUrl}>
            <Desktop aria-hidden="true" /> Continue in desktop
          </a>
        )}
        {terminalUrl && (
          <a className="button secondary" href={terminalUrl}>
            <Desktop aria-hidden="true" /> Open terminal in desktop
          </a>
        )}
        {job.ssh && (
          <button className="button" type="button" onClick={() => onCopy(command)}>
            <Copy aria-hidden="true" /> Copy SSH command
          </button>
        )}
        {canStop && !confirming && (
          <button
            ref={stopButton}
            className="button"
            type="button"
            onClick={onConfirm}
            aria-controls={`environment-${job.id}-stop`}
          >
            <Stop aria-hidden="true" /> Stop
          </button>
        )}
      </div>
      {ready && (
        <details className="resource-note">
          <summary>Desktop didn’t open?</summary>
          <p>Start the desktop app with <code>just desktop</code>, then select this project and environment.</p>
          <p>Project ID: <code>{projectId}</code><br />Environment ID: <code>{job.id}</code></p>
        </details>
      )}
      {canStop && confirming && (
        <div
          id={`environment-${job.id}-stop`}
          className="environment-confirm"
          role="group"
          aria-label="Confirm stop"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !stopBusy) onCancel();
          }}
        >
          <p>
            Stop this environment? The worker tears it down and anything not
            pushed from it is lost.
          </p>
          <div className="environment-actions">
            <button
              ref={confirmButton}
              className="button environment-danger"
              type="button"
              disabled={stopBusy}
              onClick={onStop}
            >
              {stopBusy ? "Requesting stop…" : "Confirm stop"}
            </button>
            <button className="button" type="button" disabled={stopBusy} onClick={onCancel}>
              Keep running
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
