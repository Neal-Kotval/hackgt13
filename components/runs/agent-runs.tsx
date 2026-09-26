"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  ArrowSquareOut,
  ChatText,
  CheckCircle,
  Circle,
  FileText,
  Lightbulb,
  Terminal,
  TerminalWindow,
  Warning,
  X,
  XCircle,
} from "@phosphor-icons/react";
import type { Project } from "@/lib/types";
import {
  demoGpuProfile,
  localDockerSandboxProfile,
  runpodBudgetGpuProfile,
  runpodGpuProfile,
} from "@/lib/resource-profiles";
import styles from "./agent-runs.module.css";

type RunStatus = "running" | "succeeded" | "failed" | "cancelled";
export type AgentRun = {
  id: string;
  runBoxId: string;
  projectId: string;
  employeeId: string;
  employeeName: string | null;
  agent: string;
  prompt: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  environment: { provider: string; profileId: string | null; state: string } | null;
  eventCount: number;
};
export type AgentRunEvent = {
  seq: number;
  kind: string;
  actor: "codex" | "employee";
  text: string | null;
  command: string | null;
  exitCode: number | null;
  at: string;
};

const LIST_POLL_MS = 4000;
const DETAIL_POLL_MS = 3000;

const statusLabel: Record<RunStatus, string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const profileLabels: Record<string, string> = {
  [localDockerSandboxProfile.id]: localDockerSandboxProfile.label,
  [runpodGpuProfile.id]: runpodGpuProfile.label,
  [runpodBudgetGpuProfile.id]: runpodBudgetGpuProfile.label,
  [demoGpuProfile.id]: demoGpuProfile.label,
};

function environmentLabel(run: AgentRun) {
  const environment = run.environment;
  if (!environment) return "Environment removed";
  return (environment.profileId && profileLabels[environment.profileId]) || environment.profileId || environment.provider;
}

function agentLabel(agent: string) {
  return agent === "codex" ? "Codex" : agent;
}

function time(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function clock(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString(undefined, { timeStyle: "medium" });
}

function duration(run: AgentRun, now: number) {
  const start = Date.parse(run.startedAt);
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "Unknown";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function desktopLink(run: AgentRun) {
  return `agentcloud://open?${new URLSearchParams({
    projectId: run.projectId,
    runBoxId: run.runBoxId,
    panel: "codex",
    runId: run.id,
  })}`;
}

function StatusBadge({ run }: { run: AgentRun }) {
  const Icon = run.status === "succeeded" ? CheckCircle : run.status === "running" ? Circle : XCircle;
  return (
    <span className={`${styles.badge} ${styles[run.status]}`}>
      <Icon aria-hidden="true" weight={run.status === "running" ? "fill" : "regular"} />
      {statusLabel[run.status]}
      {run.exitCode !== null && run.status !== "running" ? ` · exit ${run.exitCode}` : ""}
    </span>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function EventItem({ event }: { event: AgentRunEvent }) {
  const actor = event.actor === "employee" ? "Employee" : "Codex";
  const meta = (label: string) => (
    <div className={styles.eventMeta}>
      <strong>{actor}</strong>
      <span>{label}</span>
      <time dateTime={event.at}>{clock(event.at)}</time>
    </div>
  );
  switch (event.kind) {
    case "command.start":
    case "terminal.command":
      return (
        <li className={styles.event}>
          <Terminal aria-hidden="true" className={styles.eventIcon} />
          <div className={styles.eventBody}>
            {meta(event.kind === "terminal.command" ? "terminal command" : "command started")}
            <pre className={styles.command}>$ {event.command ?? event.text}</pre>
          </div>
        </li>
      );
    case "command.output":
      return (
        <li className={styles.event}>
          <TerminalWindow aria-hidden="true" className={styles.eventIcon} />
          <div className={styles.eventBody}>
            {meta("output")}
            {event.command && <p className={styles.eventCommand}>$ {event.command}</p>}
            <pre className={styles.output}>{event.text ?? ""}</pre>
          </div>
        </li>
      );
    case "command.exit": {
      const ok = event.exitCode === 0;
      return (
        <li className={styles.event}>
          {ok ? <CheckCircle aria-hidden="true" className={`${styles.eventIcon} ${styles.okIcon}`} />
            : <XCircle aria-hidden="true" className={`${styles.eventIcon} ${styles.errorIcon}`} />}
          <div className={styles.eventBody}>
            {meta("command finished")}
            {event.command && <p className={styles.eventCommand}>$ {event.command}</p>}
            <span className={`${styles.badge} ${ok ? styles.succeeded : styles.failed}`}>
              {event.exitCode === null ? "Exit code not reported" : `Exit code ${event.exitCode}`}
            </span>
            {event.text && <pre className={styles.output}>{event.text}</pre>}
          </div>
        </li>
      );
    }
    case "file.change":
      return (
        <li className={styles.event}>
          <FileText aria-hidden="true" className={styles.eventIcon} />
          <div className={styles.eventBody}>
            {meta("file change")}
            <pre className={styles.fileChange}>{event.text ?? ""}</pre>
          </div>
        </li>
      );
    case "error":
      return (
        <li className={`${styles.event} ${styles.errorEvent}`}>
          <Warning aria-hidden="true" className={`${styles.eventIcon} ${styles.errorIcon}`} />
          <div className={styles.eventBody}>
            {meta("error")}
            <p className={styles.errorText}>{event.text ?? "Error reported without detail."}</p>
          </div>
        </li>
      );
    case "reasoning":
      return (
        <li className={styles.event}>
          <Lightbulb aria-hidden="true" className={styles.eventIcon} />
          <div className={styles.eventBody}>
            {meta("reasoning")}
            <p className={styles.reasoning}>{event.text}</p>
          </div>
        </li>
      );
    case "status":
      return (
        <li className={`${styles.event} ${styles.statusEvent}`}>
          <Circle aria-hidden="true" className={styles.eventIcon} />
          <div className={styles.eventBody}>
            {meta("status")}
            {event.text && <p>{event.text}</p>}
          </div>
        </li>
      );
    default:
      return (
        <li className={styles.event}>
          <ChatText aria-hidden="true" className={styles.eventIcon} />
          <div className={styles.eventBody}>
            {meta("message")}
            <p className={styles.message}>{event.text}</p>
          </div>
        </li>
      );
  }
}

function RunDetail({ runId, closeHref }: { runId: string; closeHref: string }) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [events, setEvents] = useState<AgentRunEvent[]>([]);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const now = useNow(run?.status === "running");

  useEffect(() => {
    let active = true;
    let lastSeq = -1;
    let finished = false;
    let pollsAfterFinish = 0;
    let timer = 0;
    setRun(null);
    setEvents([]);
    setError("");
    async function load() {
      // Page through new events so a long run catches up in one poll.
      for (;;) {
        const response = await fetch(`/api/agent-runs/${encodeURIComponent(runId)}?afterSeq=${lastSeq}`);
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(response.status === 404 ? "This run was not found." : body.error || "Could not load this run.");
        }
        const data = (await response.json()) as { run: AgentRun; events: AgentRunEvent[]; hasMore: boolean };
        if (!active) return;
        setRun(data.run);
        if (data.events.length) {
          lastSeq = data.events[data.events.length - 1].seq;
          setEvents((current) => [...current, ...data.events]);
        }
        finished = data.run.status !== "running";
        setError("");
        if (!data.hasMore) return;
      }
    }
    const tick = () => {
      load()
        .catch((caught: unknown) => {
          if (active) setError(caught instanceof Error ? caught.message : "Could not load this run.");
        })
        .finally(() => {
          // After a run finishes, poll once more for late-flushed events, then stop.
          if (finished) pollsAfterFinish += 1;
          if (active && pollsAfterFinish < 2) timer = window.setTimeout(tick, DETAIL_POLL_MS);
        });
    };
    tick();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [runId]);

  useEffect(() => {
    heading.current?.focus();
  }, [runId]);

  return (
    <section className={styles.detail} aria-labelledby="run-detail-heading">
      <div className={styles.detailTop}>
        <div className={styles.detailTitle}>
          <p className={styles.eyebrow}>Run detail</p>
          <h3 id="run-detail-heading" ref={heading} tabIndex={-1}>
            {run ? `${agentLabel(run.agent)} run` : "Loading run…"}
          </h3>
        </div>
        <Link className={styles.close} href={closeHref} scroll={false} aria-label="Close run detail">
          <X aria-hidden="true" />
        </Link>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {run && (
        <>
          <p className={styles.prompt}>{run.prompt}</p>
          <dl className={styles.facts}>
            <div><dt>Status</dt><dd><StatusBadge run={run} /></dd></div>
            <div><dt>Employee</dt><dd>{run.employeeName ?? "Unknown employee"}</dd></div>
            <div><dt>Environment</dt><dd>{environmentLabel(run)}</dd></div>
            <div><dt>Started</dt><dd><time dateTime={run.startedAt}>{time(run.startedAt)}</time></dd></div>
            <div><dt>Duration</dt><dd>{duration(run, now)}{run.status === "running" ? " so far" : ""}</dd></div>
          </dl>
          <div className={styles.detailActions}>
            <a className="button secondary" href={desktopLink(run)}>
              Open in desktop <ArrowSquareOut aria-hidden="true" />
            </a>
            <span className={styles.note}>Trusted shell access · events are reported by the employee&apos;s desktop app</span>
          </div>
          <h4 className={styles.eventsHeading}>
            Events <span className={styles.count}>{events.length}</span>
          </h4>
          {events.length ? (
            <ol className={styles.events} aria-live="polite" aria-relevant="additions">
              {events.map((event) => <EventItem key={event.seq} event={event} />)}
            </ol>
          ) : (
            <p className={styles.note}>
              {run.status === "running" ? "No events reported yet. New events appear here as the desktop app reports them." : "This run reported no events."}
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function AgentRuns({ project }: { project: Project }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selected = searchParams.get("run");
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState("");
  const now = useNow(Boolean(runs?.some((run) => run.status === "running")));

  useEffect(() => {
    let active = true;
    async function refresh() {
      const response = await fetch(`/api/agent-runs?projectId=${encodeURIComponent(project.id)}`);
      if (!response.ok) throw new Error("Could not load agent runs.");
      const data = (await response.json()) as { runs: AgentRun[] };
      if (!active) return;
      setRuns(data.runs);
      setError("");
    }
    const report = (caught: unknown) => {
      if (active) setError(caught instanceof Error ? caught.message : "Could not load agent runs.");
    };
    refresh().catch(report);
    const timer = window.setInterval(() => refresh().catch(report), LIST_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project.id]);

  const runHref = (id: string) => `${pathname}?${new URLSearchParams({ run: id })}`;

  return (
    <section className={styles.root} aria-labelledby="agent-runs-heading">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Live · refreshes every few seconds</p>
          <h2 id="agent-runs-heading">Reported runs</h2>
        </div>
        {runs && <span className={styles.count}>{runs.length} {runs.length === 1 ? "run" : "runs"}</span>}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className={`${styles.layout} ${selected ? styles.withDetail : ""}`}>
        <div className={styles.listColumn}>
          {runs === null && !error && <p className={styles.note}>Loading agent runs…</p>}
          {runs && runs.length === 0 && (
            <div className={styles.empty}>
              <TerminalWindow aria-hidden="true" />
              <h3>No agent runs yet</h3>
              <p>Start one from the Codex panel in the desktop app with a ready environment. Its commands, output, and file changes will appear here as they are reported.</p>
            </div>
          )}
          {runs && runs.length > 0 && (
            <ul className={styles.list}>
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    className={`${styles.runLink} ${run.id === selected ? styles.selected : ""}`}
                    href={runHref(run.id)}
                    scroll={false}
                    aria-current={run.id === selected ? "true" : undefined}
                  >
                    <span className={styles.runTop}>
                      <strong>{agentLabel(run.agent)}</strong>
                      <StatusBadge run={run} />
                    </span>
                    <span className={styles.runPrompt}>{run.prompt}</span>
                    <span className={styles.runMeta}>
                      <span>{run.employeeName ?? "Unknown employee"}</span>
                      <span>{environmentLabel(run)}</span>
                      <time dateTime={run.startedAt}>{time(run.startedAt)}</time>
                      <span>{duration(run, now)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {selected && <RunDetail runId={selected} closeHref={pathname} />}
      </div>
    </section>
  );
}
