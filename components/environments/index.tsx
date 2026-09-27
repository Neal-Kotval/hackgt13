"use client";
import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChatsCircle,
  CheckCircle,
  Copy,
  Cube,
  GitBranch,
  Plus,
  ShieldWarning,
  Stop,
  Warning,
} from "@phosphor-icons/react";
import type { Project } from "@/lib/types";
import "../resources/resources.css";
import "./environments.css";
import Link from "next/link";
import { EnvironmentMemoryChip } from "@/components/environment-detail/card-summary";
import { MachinePicker, initialPickerValue, pickerRequest, type PickerValue } from "./machine-picker";
import {
  environmentLabel,
  expiresAt,
  jobDiskGib,
  jobMachine,
  machineSpecs,
  repoName,
  timeLeft,
  type ContainerTemplate,
  type EnvironmentJob,
  type JobState,
} from "./machines";

export type { EnvironmentJob } from "./machines";

type Role = "owner" | "member" | null;
type CodexSession = { isSetupSession?: boolean; target?: { kind: string; runBoxId?: string } };

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
    detail: "Shutdown can take several minutes. Waiting for the provider to confirm this environment is released.",
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

export function profileLabel(job: EnvironmentJob, templates: ContainerTemplate[] = []) {
  return environmentLabel(job, templates);
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
  const [templates, setTemplates] = useState<ContainerTemplate[]>([]);
  const [role, setRole] = useState<Role>(null);
  const [loadError, setLoadError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [picker, setPicker] = useState<PickerValue>(initialPickerValue);
  const [chatCounts, setChatCounts] = useState<Map<string, number> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [showStopped, setShowStopped] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [confirmingStop, setConfirmingStop] = useState("");
  const [stopBusy, setStopBusy] = useState("");
  const [memoryBusy, setMemoryBusy] = useState("");
  const [confirmingForce, setConfirmingForce] = useState("");
  const [forceBusy, setForceBusy] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const formHeading = useRef<HTMLHeadingElement>(null);
  const focusedEnvironment = useRef(false);

  useEffect(() => {
    setServerUrl(window.location.origin);
    // The overview's "New environment" action links here with ?new=1.
    if (new URL(window.location.href).searchParams.get("new") === "1") setShowForm(true);
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (focusedEnvironment.current || !jobs) return;
    const selected = new URL(window.location.href).searchParams.get("environment");
    if (!selected || !jobs.some(job => job.id === selected)) return;
    focusedEnvironment.current = true;
    if (jobs.find((job) => job.id === selected)?.state === "stopped") setShowStopped(true);
    window.requestAnimationFrame(() => document.getElementById(`rb-${selected}`)?.scrollIntoView({ block: "start" }));
  }, [jobs]);

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
      const data = (await jobsResponse.json()) as { jobs: EnvironmentJob[]; templates?: ContainerTemplate[] };
      if (!active) return;
      setRole(employee.memberships.find((item) => item.projectId === project.id)?.role ?? null);
      setJobs(data.jobs);
      setTemplates(data.templates ?? []);
      setLoadError("");
      setNow(Date.now());
      // Codex chat counts are optional context; a failed lookup hides them rather than showing zero.
      try {
        const sessionsResponse = await fetch(`/api/codex-sessions?projectId=${encodeURIComponent(project.id)}`);
        const sessions = sessionsResponse.ok ? ((await sessionsResponse.json()) as { sessions?: CodexSession[] }).sessions : undefined;
        if (!active) return;
        if (!Array.isArray(sessions)) { setChatCounts(null); return; }
        const counts = new Map<string, number>();
        for (const session of sessions)
          if (session.target?.kind === "runBox" && session.target.runBoxId && session.isSetupSession === false)
            counts.set(session.target.runBoxId, (counts.get(session.target.runBoxId) ?? 0) + 1);
        setChatCounts(counts);
      } catch {
        if (active) setChatCounts(null);
      }
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

  async function setMemory(job: EnvironmentJob, enabled: boolean) {
    setMemoryBusy(job.id);
    setActionError("");
    try {
      const response = await fetch(`/api/run-boxes/${encodeURIComponent(job.id)}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, enabled }),
      });
      const data = (await response.json()) as { error?: string; memory?: EnvironmentJob["memory"] };
      if (!response.ok || !data.memory) throw new Error(data.error || "Could not update shared memory.");
      setJobs((current) => current?.map((item) => item.id === job.id ? { ...item, memory: data.memory } : item) ?? current);
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not update shared memory.");
    } finally {
      setMemoryBusy("");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFormError("");
    setNotice("");
    try {
      const response = await fetch("/api/run-boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, ...pickerRequest(picker), idempotencyKey }),
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

  // HAC-168: closes a job at once only if no machine was ever launched; otherwise the
  // server requests termination and the job keeps blocking until release is confirmed.
  async function forceStop(job: EnvironmentJob) {
    setForceBusy(job.id);
    setActionError("");
    setNotice("");
    try {
      const response = await fetch(`/api/run-boxes/${encodeURIComponent(job.id)}/force-stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      const data = (await response.json()) as {
        job?: EnvironmentJob;
        outcome?: "stopped" | "termination-requested";
        error?: string;
      };
      if (!response.ok || !data.job) throw new Error(data.error || "Force stop was not saved.");
      setJobs((current) =>
        (current ?? []).map((item) => (item.id === job.id ? { ...item, ...data.job! } : item)),
      );
      setConfirmingForce("");
      setNotice(
        data.outcome === "stopped"
          ? "Stopped. No machine was ever launched for this environment, so it was closed immediately."
          : "Termination requested. Waiting for the provider to confirm this environment is released.",
      );
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not force stop.");
    } finally {
      setForceBusy("");
    }
  }

  async function copy(text: string, message = "SSH command copied.") {
    setActionError("");
    try {
      await navigator.clipboard.writeText(text);
      setNotice(message);
    } catch {
      setActionError("Clipboard unavailable. Select the command to copy it.");
    }
  }

  const empty = jobs !== null && jobs.length === 0;
  const active = (jobs ?? []).filter((job) => job.state !== "stopped");
  const stopped = (jobs ?? []).filter((job) => job.state === "stopped");
  const renderCard = (job: EnvironmentJob) => (
    <EnvironmentCard
      key={job.id}
      job={job}
      templates={templates}
      projectId={project.id}
      chatCount={chatCounts ? chatCounts.get(job.id) ?? 0 : null}
      now={now}
      serverUrl={serverUrl}
      role={role}
      confirming={confirmingStop === job.id}
      stopBusy={stopBusy === job.id}
      onConfirm={() => setConfirmingStop(job.id)}
      onCancel={() => setConfirmingStop("")}
      onStop={() => void stop(job)}
      forceConfirming={confirmingForce === job.id}
      forceBusy={forceBusy === job.id}
      onForceConfirm={() => setConfirmingForce(job.id)}
      onForceCancel={() => setConfirmingForce("")}
      onForceStop={() => void forceStop(job)}
      onCopy={(text, message) => void copy(text, message)}
      memoryBusy={memoryBusy === job.id}
      onMemory={(enabled) => void setMemory(job, enabled)}
    />
  );

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
          <MachinePicker value={picker} onChange={setPicker} templates={templates} />
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

      {jobs === null && !loadError && <SkeletonRegion label="Loading environments"><SkeletonRows count={2} /></SkeletonRegion>}

      {jobs && jobs.length > 0 && (
        <section className="environment-list-section" aria-labelledby="environment-list-title">
          <h3 id="environment-list-title" className="environment-list-title">
            Running in this project <span className="resource-count">{active.length}</span>
          </h3>
          {active.length > 0 ? (
            <ul className="environment-list">
              {active.map(renderCard)}
            </ul>
          ) : (
            <p className="resource-note">Nothing is running for this project. Stopped environments are listed below.</p>
          )}
          {stopped.length > 0 && (
            <details
              className="environment-stopped"
              open={showStopped}
              onToggle={(event) => setShowStopped(event.currentTarget.open)}
            >
              <summary>Stopped environments ({stopped.length})</summary>
              <ul className="environment-list">
                {stopped.map(renderCard)}
              </ul>
            </details>
          )}
        </section>
      )}
    </section>
  );
}

function EnvironmentMemory({
  job,
  owner,
  busy,
  onMemory,
}: {
  job: EnvironmentJob;
  owner: boolean;
  busy: boolean;
  onMemory: (enabled: boolean) => void;
}) {
  const enabled = job.memory?.enabled === true;
  const available = job.memory?.available === true;
  const stopped = job.state === "stopped";
  const titleId = `environment-${job.id}-memory`;
  const reason = stopped
    ? "This environment is stopped."
    : !owner
      ? "Only a project owner can change shared memory."
      : !available
        ? "This server has no Backboard key yet. The choice is saved and notes start once the key is set."
        : enabled
          ? "Agents on this environment share notes. They still cannot see each other's computers."
          : "Turn this on so agents on this environment can hand work to each other.";
  return (
    <div className="environment-memory">
      <div className="environment-memory-copy">
        <p id={titleId} className="environment-memory-title">Shared memory</p>
        <p className="resource-note">{reason}</p>
      </div>
      <button
        className="environment-switch"
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={titleId}
        disabled={!owner || stopped || busy}
        onClick={() => onMemory(!enabled)}
      >
        {busy ? "Saving…" : enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

function EnvironmentCard({
  job,
  templates,
  projectId,
  chatCount,
  now,
  serverUrl,
  role,
  confirming,
  stopBusy,
  onConfirm,
  onCancel,
  onStop,
  forceConfirming,
  forceBusy,
  onForceConfirm,
  onForceCancel,
  onForceStop,
  onCopy,
  memoryBusy,
  onMemory,
}: {
  job: EnvironmentJob;
  templates: ContainerTemplate[];
  projectId: string;
  chatCount: number | null;
  now: number;
  serverUrl: string;
  role: Role;
  confirming: boolean;
  stopBusy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onStop: () => void;
  forceConfirming: boolean;
  forceBusy: boolean;
  onForceConfirm: () => void;
  onForceCancel: () => void;
  onForceStop: () => void;
  onCopy: (text: string, message?: string) => void;
  memoryBusy: boolean;
  onMemory: (enabled: boolean) => void;
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
  const forceConfirmButton = useRef<HTMLButtonElement>(null);
  const forceButton = useRef<HTMLButtonElement>(null);
  const wasForceConfirming = useRef(false);
  useEffect(() => {
    if (forceConfirming) forceConfirmButton.current?.focus();
    else if (wasForceConfirming.current) forceButton.current?.focus();
    wasForceConfirming.current = forceConfirming;
  }, [forceConfirming]);
  const titleId = `environment-${job.id}-title`;
  const failure = job.failureReason ?? job.failure_reason;
  const expires = expiresAt(job);
  const machine = jobMachine(job);
  const disk = jobDiskGib(job);
  const specs = machine
    ? `${machineSpecs(machine, disk)} · ${machine.instanceType}`
    : job.provider === "docker-local"
      ? "CPU-only container on the worker host · no GPU · no provider cost"
      : null;
  const command = job.ssh ? sshCommand(job.ssh) : "";
  const canStop = role === "owner" && job.state !== "stopped" && !job.stop_requested_at;
  const ready = job.state === "ready" && !job.stop_requested_at;
  // Failed and stopping jobs still count toward the owner’s cloud environment limit.
  const canForceStop = role === "owner" && job.state !== "stopped" && !job.force_stop_requested_at &&
    (Boolean(job.stop_requested_at) || job.state === "failed" || job.state === "stopping");
  const terminationRequested = Boolean(job.force_stop_requested_at) && job.state !== "stopped";
  const chatUrl = ready && serverUrl
    ? `agentcloud://open?${new URLSearchParams({ projectId, runBoxId: job.id, panel: "codex", serverUrl })}`
    : "";
  const stopped = job.state === "stopped";
  const stopDetail =
    stopped && !job.provider_resource_id
      ? "Stopped before a machine was allocated."
      : terminationRequested
        ? "Termination requested. Waiting for the provider to confirm this environment is released."
        : copy.detail;
  const phase = terminationRequested ? "Termination requested" : copy.phase;

  return (
    <li id={`rb-${job.id}`} className="resource-request-card resource-panel environment-card" aria-labelledby={titleId}>
      <div className="resource-detail-title">
        <div className="environment-title">
          {/* Environment detail link (env-detail-page). Keep when redesigning this card. */}
          <h4 id={titleId}>
            <Link className="environment-open-link" href={`/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(job.id)}`}>
              {job.name || profileLabel(job, templates)}
            </Link>
          </h4>
          {specs && <p className="environment-specs">{job.name ? `${profileLabel(job, templates)} · ` : ""}{specs}</p>}
        </div>
        <span className={`resource-badge resource-badge--${job.state}`}>{copy.label}</span>
      </div>
      {(job.repo_url || chatCount !== null) && (
        <p className="environment-coupling">
          {job.repo_url && (
            <span>
              <GitBranch aria-hidden="true" />
              Clones <strong title={job.repo_url}>{repoName(job.repo_url)}</strong>
              {" · "}
              {job.repo_revision ? <code title={job.repo_revision}>{job.repo_revision.slice(0, 7)}</code> : "revision pending"}
            </span>
          )}
          {chatCount !== null && (
            <span>
              <ChatsCircle aria-hidden="true" />
              {chatCount} Codex {chatCount === 1 ? "chat" : "chats"}
            </span>
          )}
        </p>
      )}
      <p className="resource-note">
        {phase !== copy.label && <strong className="environment-phase">{phase}. </strong>}
        {stopDetail}
      </p>
      <dl className="resource-facts resource-facts--compact environment-facts">
        <div>
          <dt>Time limit</dt>
          <dd>
            {job.max_duration_minutes / 60} {job.max_duration_minutes === 60 ? "hour" : "hours"}
            {job.state !== "stopped" && ` · ${timeLeft(job, now)}`}
            {Number.isFinite(expires) && <small className="environment-fact-detail">Expires {readableDate(expires)}</small>}
          </dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>
            {providerLabel(job.provider)}
            {job.provider_resource_id ? ` · ${job.provider_resource_id}` : " · not allocated"}
          </dd>
        </div>
        <div>
          <dt>Environment ID</dt>
          <dd className="environment-id">
            <code title={job.id}>{job.id.slice(0, 8)}</code>
            <button
              className="button ghost environment-id-copy"
              type="button"
              aria-label={`Copy full environment ID ${job.id}`}
              onClick={() => onCopy(job.id, "Environment ID copied.")}
            >
              <Copy aria-hidden="true" /> Copy full ID
            </button>
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{readableDate(job.created_at)}</dd>
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
        {job.force_stop_requested_at && (
          <div>
            <dt>Force stop requested</dt>
            <dd>{readableDate(job.force_stop_requested_at)}</dd>
          </div>
        )}
      </dl>

      {!stopped && (
        <>
      {/* Shared memory is changed on the environment detail page (env-detail-page); the card shows status only. */}
      <EnvironmentMemoryChip job={job} projectId={projectId} />

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
        </>
      )}

      {ready && job.ssh && <p className="resource-note">Your environment is ready. Add Codex or manage its sign-in in Settings.</p>}
      <div className="environment-actions">
        {ready && job.ssh && <Link className="button primary" href={`/projects/${projectId}/settings?environment=${job.id}#agent-setup`}>Agent settings</Link>}
        {chatUrl && <a className="button" href={chatUrl}>Open in desktop</a>}
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
        {canForceStop && !forceConfirming && (
          <button
            ref={forceButton}
            className="button danger"
            type="button"
            onClick={onForceConfirm}
            aria-controls={`environment-${job.id}-force-stop`}
          >
            <Warning aria-hidden="true" /> Force stop
          </button>
        )}
      </div>
      {ready && (
        <details className="resource-note">
          <summary>Desktop didn’t open?</summary>
          <p><Link href="/download">Download the desktop app</Link>, open it and sign in, then select this project and environment.</p>
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
      {canForceStop && forceConfirming && (
        <div
          id={`environment-${job.id}-force-stop`}
          className="environment-confirm"
          role="group"
          aria-label="Confirm force stop"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !forceBusy) onForceCancel();
          }}
        >
          <p>
            Force stop this environment? If no machine was ever launched, it closes now.
            Otherwise AgentCloud requests termination from the provider, and this
            environment is not fully released until the provider confirms teardown.
            Anything not pushed from it is lost.
          </p>
          <div className="environment-actions">
            <button
              ref={forceConfirmButton}
              className="button danger"
              type="button"
              disabled={forceBusy}
              onClick={onForceStop}
            >
              {forceBusy ? "Requesting force stop…" : "Confirm force stop"}
            </button>
            <button className="button" type="button" disabled={forceBusy} onClick={onForceCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
