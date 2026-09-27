"use client";
// Environment detail page: /projects/:projectId/environments/:jobId
// Data and access rules come from docs/environment-model-contract.md. The UI reflects the
// server's `permissions`; it never decides access itself.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle,
  Clock,
  Cpu,
  Globe,
  LockSimple,
  Stop,
  Trash,
  Warning,
  X,
} from "@phosphor-icons/react";
import { Skeleton, SkeletonPanel, SkeletonRegion } from "@/components/ui/skeleton";
import { EnvironmentChat } from "./chat";
import { EnvironmentTerminal } from "./terminal";
import {
  environmentName,
  expiresAt,
  machineLabel,
  machineSpecs,
  memoryExplanation,
  memoryStatus,
  noPermissions,
  progressInfo,
  providerLabel,
  readableDate,
  shortId,
  stateInfo,
  timeLeft,
  type RunBoxJob,
} from "./types";
import "./environment-detail.css";

const tabs = [
  { id: "overview", label: "Overview" },
  { id: "chat", label: "Chat" },
  { id: "terminal", label: "Terminal" },
  { id: "settings", label: "Settings" },
] as const;
type TabId = (typeof tabs)[number]["id"];

const manageExplanation =
  "Only the person who created this environment or a project owner can rename it, change its visibility, or delete it.";
const visibilityExplanation =
  "Private: only you. Public: every project member can open, chat, use the terminal, and stop it.";

type Load =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; job: RunBoxJob };

async function readJson(response: Response) {
  try {
    return (await response.json()) as { job?: RunBoxJob; error?: string; ok?: boolean };
  } catch {
    return {};
  }
}

function jobUrl(jobId: string) {
  return `/api/run-boxes/${encodeURIComponent(jobId)}`;
}

export function EnvironmentDetail({ projectId, jobId }: { projectId: string; jobId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: TabId = tabs.some((item) => item.id === requested) ? (requested as TabId) : "overview";
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const listHref = `/projects/${projectId}/environments`;

  const fetchJob = useCallback(async () => {
    const response = await fetch(`${jobUrl(jobId)}?${new URLSearchParams({ projectId })}`, { cache: "no-store" });
    if (response.status === 404) return setLoad({ status: "missing" });
    const data = await readJson(response);
    if (!response.ok || !data.job)
      return setLoad({ status: "error", message: data.error || "Could not load this environment." });
    setLoad({ status: "ready", job: data.job });
  }, [jobId, projectId]);

  useEffect(() => {
    setLoad({ status: "loading" });
    fetchJob().catch(() => setLoad({ status: "error", message: "Could not load this environment." }));
  }, [fetchJob]);

  // Keep state and time left current while the environment is active.
  const active = load.status === "ready" && load.job.state !== "stopped";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      fetchJob().catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [active, fetchJob]);

  function selectTab(next: TabId) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params}`, { scroll: false });
  }

  const back = (
    <Link className="environment-detail-back" href={listHref}>
      <ArrowLeft aria-hidden="true" />
      Environments
    </Link>
  );

  if (load.status === "loading")
    return (
      <div className="environment-detail">
        {back}
        <SkeletonRegion label="Loading environment" className="environment-detail-loading">
          <Skeleton variant="title" width="40" />
          <Skeleton width="60" />
          <SkeletonPanel rows={3} icon={false} />
        </SkeletonRegion>
      </div>
    );

  if (load.status === "missing" || load.status === "error")
    return (
      <div className="environment-detail">
        {back}
        <div className="environment-detail-missing" role={load.status === "error" ? "alert" : undefined}>
          <Warning aria-hidden="true" />
          <h1>{load.status === "missing" ? "Environment not found or private" : "Environment unavailable"}</h1>
          <p>
            {load.status === "missing"
              ? "It may have been deleted, or it is private to the person who created it."
              : load.message}
          </p>
          <Link className="button" href={listHref}>
            Back to Environments
          </Link>
        </div>
      </div>
    );

  const job = load.job;
  const state = stateInfo(job.state);
  const isPublic = job.visibility === "public";

  return (
    <div className="environment-detail">
      {back}
      <header className="environment-detail-header">
        <div className="environment-detail-heading">
          <h1 className={job.name ? undefined : "environment-detail-unnamed"}>{environmentName(job)}</h1>
          <div className="environment-detail-badges">
            <span className={`environment-state environment-state--${job.state}`}>
              <span className="environment-state-dot" aria-hidden="true" />
              {state.label}
            </span>
            <span className="environment-visibility">
              {isPublic ? <Globe aria-hidden="true" /> : <LockSimple aria-hidden="true" />}
              {isPublic ? "Public" : "Private"}
            </span>
          </div>
        </div>
        <p className="environment-detail-meta">
          <span>
            <Cpu aria-hidden="true" />
            {machineLabel(job)}
          </span>
          <span>
            <Clock aria-hidden="true" />
            {timeLeft(job, now)}
          </span>
        </p>
      </header>

      <Tabs active={tab} onSelect={selectTab} />

      <div
        className="environment-detail-panel"
        role="tabpanel"
        id={`environment-panel-${tab}`}
        aria-labelledby={`environment-tab-${tab}`}
        tabIndex={0}
      >
        {tab === "overview" && (
          <Overview job={job} projectId={projectId} now={now} onJob={(next) => setLoad({ status: "ready", job: next })} />
        )}
        {tab === "chat" && <EnvironmentChat projectId={projectId} job={job} />}
        {tab === "terminal" && <EnvironmentTerminal projectId={projectId} job={job} />}
        {tab === "settings" && (
          <Settings
            job={job}
            projectId={projectId}
            onJob={(next) => setLoad({ status: "ready", job: next })}
            onDeleted={() => router.push(listHref)}
          />
        )}
      </div>
    </div>
  );
}

function Tabs({ active, onSelect }: { active: TabId; onSelect: (tab: TabId) => void }) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((item) => item.id === active);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = tabs[next].id;
    onSelect(id);
    refs.current[id]?.focus();
  }
  return (
    <div className="environment-tabs" role="tablist" aria-label="Environment sections" onKeyDown={onKeyDown}>
      {tabs.map((item) => (
        <button
          key={item.id}
          ref={(node) => {
            refs.current[item.id] = node;
          }}
          id={`environment-tab-${item.id}`}
          className="environment-tab"
          type="button"
          role="tab"
          aria-selected={item.id === active}
          aria-controls={`environment-panel-${item.id}`}
          tabIndex={item.id === active ? 0 : -1}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Overview({
  job,
  projectId,
  now,
  onJob,
}: {
  job: RunBoxJob;
  projectId: string;
  now: number;
  onJob: (job: RunBoxJob) => void;
}) {
  const permissions = job.permissions ?? noPermissions;
  const state = stateInfo(job.state);
  const specs = machineSpecs(job);
  const failure = job.failureReason ?? job.failure_reason;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const stopButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (wasConfirming.current) stopButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  const canStop = permissions.stop && job.state !== "stopped" && !job.stop_requested_at;

  async function stop() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${jobUrl(job.id)}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await readJson(response);
      if (!response.ok || !data.job) throw new Error(data.error || "Stop request was not saved.");
      onJob({ ...job, ...data.job });
      setConfirming(false);
      setNotice("Stop requested. The environment is released only after the worker confirms teardown.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not request a stop.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="environment-overview">
      <section className="environment-detail-section" aria-labelledby="environment-overview-state">
        <h2 id="environment-overview-state">State</h2>
        <p className="environment-detail-note">
          {progressInfo(job)?.detail ?? (job.force_stop_requested_at && job.state !== "stopped"
            ? "Termination requested. The worker must confirm the provider released this environment."
            : state.detail)}
        </p>
        {failure && (
          <p className="environment-detail-failure" role="status">
            <Warning aria-hidden="true" />
            {failure}
          </p>
        )}
        <ol className="environment-timeline">
          <li>
            <span>Created</span>
            <time dateTime={job.created_at}>{readableDate(job.created_at)}</time>
          </li>
          {job.stop_requested_at && (
            <li>
              <span>Stop requested</span>
              <time dateTime={job.stop_requested_at}>{readableDate(job.stop_requested_at)}</time>
            </li>
          )}
          {job.force_stop_requested_at && (
            <li>
              <span>Force stop requested</span>
              <time dateTime={job.force_stop_requested_at}>{readableDate(job.force_stop_requested_at)}</time>
            </li>
          )}
          <li>
            <span>{job.state === "stopped" ? "Time limit was" : "Time limit"}</span>
            <time dateTime={new Date(expiresAt(job)).toISOString()}>
              {readableDate(expiresAt(job))} · {timeLeft(job, now)}
            </time>
          </li>
        </ol>
      </section>

      <section className="environment-detail-section" aria-labelledby="environment-overview-facts">
        <h2 id="environment-overview-facts">Details</h2>
        <dl className="environment-facts">
          <div>
            <dt>Machine</dt>
            <dd>
              {machineLabel(job)}
              {specs && <span className="environment-facts-secondary">{specs}</span>}
            </dd>
          </div>
          <div>
            <dt>Provider</dt>
            <dd>
              {providerLabel(job.provider)}
              <span className="environment-facts-secondary">
                {job.provider_resource_id ? <code>{job.provider_resource_id}</code> : "Not allocated"}
              </span>
            </dd>
          </div>
          <div>
            <dt>Repository</dt>
            <dd>
              {job.repo_url ? <code>{job.repo_url.replace(/^https?:\/\//, "")}</code> : "None"}
              {job.repo_revision && (
                <span className="environment-facts-secondary">
                  Revision <code>{job.repo_revision.slice(0, 12)}</code>
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Created by</dt>
            <dd>
              {job.createdBy ? job.createdBy.name || job.createdBy.email : "Not recorded"}
              {job.createdBy?.name && job.createdBy.email && (
                <span className="environment-facts-secondary">{job.createdBy.email}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Visibility</dt>
            <dd>
              {job.visibility === "public" ? "Public" : "Private"}
              <span className="environment-facts-secondary">
                {job.visibility === "public"
                  ? "Every project member can open, chat, use the terminal, and stop it."
                  : "Only the person who created it can open it."}
              </span>
            </dd>
          </div>
          <div>
            <dt>Shared memory</dt>
            <dd>{job.memory ? memoryStatus(job) : "Not reported by this server"}</dd>
          </div>
          <div>
            <dt>Environment ID</dt>
            <dd>
              <code title={job.id}>{shortId(job)}</code>
            </dd>
          </div>
        </dl>
      </section>

      {job.state !== "stopped" && (
        <section className="environment-detail-section" aria-labelledby="environment-overview-stop">
          <h2 id="environment-overview-stop">Stop</h2>
          <p className="environment-detail-note">
            {job.stop_requested_at
              ? "Shutdown is in progress and can take several minutes. You do not need to request it again."
              : permissions.stop
                ? "Stopping terminates the machine. Work that is not pushed is lost."
                : "You cannot stop this environment."}
          </p>
          {canStop && !confirming && (
            <button ref={stopButton} className="button danger" type="button" onClick={() => setConfirming(true)}>
              <Stop aria-hidden="true" />
              Stop environment
            </button>
          )}
          {canStop && confirming && (
            <div className="environment-detail-confirm" role="group" aria-label="Confirm stop">
              <p>Stop this environment now?</p>
              <div className="environment-detail-actions">
                <button
                  ref={confirmButton}
                  className="button danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void stop()}
                >
                  {busy ? "Stopping…" : "Confirm stop"}
                </button>
                <button className="button" type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="environment-detail-error" role="alert">
              <Warning aria-hidden="true" />
              {error}
            </p>
          )}
          {notice && (
            <p className="environment-detail-success" role="status">
              <CheckCircle aria-hidden="true" />
              {notice}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

// Name rules match the contract: 1–60 characters after trim, no control characters.
function nameError(value: string) {
  const trimmed = value.trim();
  if (trimmed.length > 60) return "Use 60 characters or fewer.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return "Remove control characters.";
  return "";
}

async function patchJob(job: RunBoxJob, projectId: string, changes: { name?: string | null; visibility?: "private" | "public" }) {
  const response = await fetch(jobUrl(job.id), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, ...changes }),
  });
  if (response.status === 404) throw new Error("Environment not found or private.");
  const data = await readJson(response);
  if (!response.ok || !data.job) throw new Error(data.error || "Changes were not saved.");
  return data.job;
}

function Settings({
  job,
  projectId,
  onJob,
  onDeleted,
}: {
  job: RunBoxJob;
  projectId: string;
  onJob: (job: RunBoxJob) => void;
  onDeleted: () => void;
}) {
  const permissions = job.permissions ?? noPermissions;
  const disabled = !permissions.manage;
  const nameId = useId();
  const nameHintId = useId();
  const visibilityLabelId = useId();
  const visibilityHintId = useId();
  const [name, setName] = useState(job.name ?? "");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameStatus, setNameStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [visibilityStatus, setVisibilityStatus] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const memoryLabelId = useId();
  const memoryHintId = useId();
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const memoryOn = job.memory?.enabled === true;
  const memoryReason = disabled
    ? "You can't change shared memory for this environment."
    : job.state === "stopped"
      ? "This environment is stopped."
      : job.memory && !job.memory.available
        ? "Shared memory is not configured on this server. The choice is saved and takes effect once it is."
        : "";
  const isPublic = job.visibility === "public";
  const invalid = nameError(name);
  const unchanged = (name.trim() || null) === (job.name ?? null);

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (invalid || unchanged) return;
    setNameBusy(true);
    setNameStatus(null);
    try {
      const next = await patchJob(job, projectId, { name: name.trim() || null });
      onJob({ ...job, ...next });
      setName(next.name ?? "");
      setNameStatus({ tone: "success", text: next.name ? "Name saved." : "Name cleared." });
    } catch (caught) {
      setNameStatus({ tone: "error", text: caught instanceof Error ? caught.message : "Name was not saved." });
    } finally {
      setNameBusy(false);
    }
  }

  async function toggleMemory() {
    setMemoryBusy(true);
    setMemoryError("");
    try {
      const response = await fetch(`${jobUrl(job.id)}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, enabled: !memoryOn }),
      });
      const data = (await response.json().catch(() => ({}))) as { memory?: RunBoxJob["memory"]; error?: string };
      if (!response.ok || !data.memory) throw new Error(data.error || "Could not update shared memory.");
      onJob({ ...job, memory: data.memory });
    } catch (caught) {
      setMemoryError(caught instanceof Error ? caught.message : "Could not update shared memory.");
    } finally {
      setMemoryBusy(false);
    }
  }

  async function toggleVisibility() {
    setVisibilityBusy(true);
    setVisibilityStatus(null);
    try {
      const next = await patchJob(job, projectId, { visibility: isPublic ? "private" : "public" });
      onJob({ ...job, ...next });
      setVisibilityStatus({
        tone: "success",
        text: next.visibility === "public" ? "Now public to project members." : "Now private to you.",
      });
    } catch (caught) {
      setVisibilityStatus({ tone: "error", text: caught instanceof Error ? caught.message : "Visibility was not saved." });
    } finally {
      setVisibilityBusy(false);
    }
  }

  return (
    <div className="environment-settings">
      {disabled && (
        <p className="environment-detail-locked" role="note">
          <LockSimple aria-hidden="true" />
          {manageExplanation}
        </p>
      )}

      <section className="environment-detail-section" aria-labelledby="environment-settings-name">
        <h2 id="environment-settings-name">Name</h2>
        <form className="environment-rename" onSubmit={(event) => void rename(event)} noValidate>
          <label htmlFor={nameId}>Environment name</label>
          <div className="environment-rename-row">
            <input
              id={nameId}
              value={name}
              maxLength={80}
              placeholder={`Unnamed environment · ${shortId(job)}`}
              aria-describedby={nameHintId}
              aria-invalid={Boolean(invalid)}
              disabled={disabled || nameBusy}
              onChange={(event) => {
                setName(event.target.value);
                setNameStatus(null);
              }}
            />
            <button className="button primary" type="submit" disabled={disabled || nameBusy || Boolean(invalid) || unchanged}>
              {nameBusy ? "Saving…" : "Save name"}
            </button>
          </div>
          <small id={nameHintId} className={invalid ? "environment-detail-error" : undefined}>
            {invalid || "Up to 60 characters. Leave it empty to remove the name."}
          </small>
        </form>
        {nameStatus && <StatusLine tone={nameStatus.tone} text={nameStatus.text} />}
      </section>

      <section className="environment-detail-section" aria-labelledby="environment-settings-visibility">
        <h2 id="environment-settings-visibility">Visibility</h2>
        <div className="environment-visibility-row">
          <div>
            <p id={visibilityLabelId} className="environment-visibility-label">
              Public to project members
            </p>
            <p id={visibilityHintId} className="environment-detail-note">
              {visibilityExplanation}
            </p>
          </div>
          <button
            className="environment-detail-switch"
            type="button"
            role="switch"
            aria-checked={isPublic}
            aria-labelledby={visibilityLabelId}
            aria-describedby={visibilityHintId}
            disabled={disabled || visibilityBusy}
            onClick={() => void toggleVisibility()}
          >
            {isPublic ? <Globe aria-hidden="true" /> : <LockSimple aria-hidden="true" />}
            {visibilityBusy ? "Saving…" : isPublic ? "Public" : "Private"}
          </button>
        </div>
        {visibilityStatus && <StatusLine tone={visibilityStatus.tone} text={visibilityStatus.text} />}
      </section>

      <section className="environment-detail-section" aria-labelledby="environment-settings-memory">
        <h2 id="environment-settings-memory">Shared memory</h2>
        <div className="environment-visibility-row">
          <div>
            <p id={memoryLabelId} className="environment-visibility-label">
              Shared project memory
            </p>
            <p id={memoryHintId} className="environment-detail-note">
              {memoryExplanation}
              {memoryReason && <> {memoryReason}</>}
            </p>
          </div>
          <button
            className="environment-detail-switch"
            type="button"
            role="switch"
            aria-checked={memoryOn}
            aria-labelledby={memoryLabelId}
            aria-describedby={memoryHintId}
            disabled={disabled || job.state === "stopped" || memoryBusy || !job.memory}
            onClick={() => void toggleMemory()}
          >
            {memoryBusy ? "Saving…" : memoryOn ? "On" : "Off"}
          </button>
        </div>
        {memoryError && <StatusLine tone="error" text={memoryError} />}
      </section>

      <section className="environment-detail-section environment-danger-zone" aria-labelledby="environment-settings-delete">
        <h2 id="environment-settings-delete">Delete environment</h2>
        <p className="environment-detail-note">
          Force-stops the machine and removes the environment from the list. The audit record stays.
        </p>
        <button className="button danger" type="button" disabled={disabled} onClick={() => setDeleting(true)}>
          <Trash aria-hidden="true" />
          Delete environment
        </button>
      </section>

      {deleting && (
        <DeleteDialog job={job} projectId={projectId} onClose={() => setDeleting(false)} onDeleted={onDeleted} />
      )}
    </div>
  );
}

function StatusLine({ tone, text }: { tone: "error" | "success"; text: string }) {
  return (
    <p className={tone === "error" ? "environment-detail-error" : "environment-detail-success"} role={tone === "error" ? "alert" : "status"}>
      {tone === "error" ? <Warning aria-hidden="true" /> : <CheckCircle aria-hidden="true" />}
      {text}
    </p>
  );
}

function DeleteDialog({
  job,
  projectId,
  onClose,
  onDeleted,
}: {
  job: RunBoxJob;
  projectId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const expected = job.name?.trim() || shortId(job);
  const matches = typed.trim() === expected || typed.trim() === shortId(job);

  // showModal() makes the rest of the page inert and handles Escape; the Tab handler below keeps
  // focus cycling inside the dialog, and cleanup returns focus to the control that opened it.
  useEffect(() => {
    const trigger = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    inputRef.current?.focus();
    return () => {
      dialog?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  function trapTab(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab" || !ref.current) return;
    const focusable = Array.from(
      ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)"),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${jobUrl(job.id)}?${new URLSearchParams({ projectId })}`, { method: "DELETE" });
      if (response.status === 404) throw new Error("Environment not found or private.");
      const data = await readJson(response);
      if (!response.ok || !data.ok) throw new Error(data.error || "The environment was not deleted.");
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The environment was not deleted.");
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="environment-delete-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={trapTab}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="modal-inner">
        <header>
          <h2 id={titleId}>Delete environment?</h2>
          <button className="button ghost square" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <form className="environment-delete-form" onSubmit={(event) => void confirm(event)}>
          <p id={descriptionId}>
            This force-stops the machine and deletes <strong>{environmentName(job)}</strong> from the list. Work
            that is not pushed is lost. This cannot be undone.
          </p>
          <label htmlFor={inputId}>
            Type <code>{expected}</code>
            {job.name?.trim() ? <> or <code>{shortId(job)}</code></> : null} to confirm
          </label>
          <input
            ref={inputRef}
            id={inputId}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setTyped(event.target.value)}
          />
          {error && <StatusLine tone="error" text={error} />}
          <div className="environment-detail-actions">
            <button className="button danger" type="submit" disabled={!matches || busy}>
              <Trash aria-hidden="true" />
              {busy ? "Deleting…" : "Delete environment"}
            </button>
            <button className="button" type="button" disabled={busy} onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
