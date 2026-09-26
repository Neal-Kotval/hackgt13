import { useCallback, useEffect, useState } from "react";
import { TerminalPanel } from "./TerminalPanel";
import { desktopApi } from "../lib/desktop-api";
import type { DeepLinkParseResult } from "../lib/deep-link";
import {
  canOpenTerminal,
  isTransitional,
  runBoxStateLabel,
  runBoxStateTone,
  terminalBlockedReason,
} from "../lib/run-boxes";
import { getState } from "../lib/server-api";
import { ipcErrorMessage } from "../lib/terminal-theme";
import type {
  AgentCloudStateSummary,
  DeviceKeyStatus,
  RunBoxSummary,
} from "../lib/types";

const POLL_MS = 5000;

type ProjectsLoad =
  | { kind: "loading" }
  | { kind: "ok"; state: AgentCloudStateSummary }
  | { kind: "error"; message: string };

type JobsLoad =
  | { kind: "idle" }
  | { kind: "loading"; projectId: string; previous: RunBoxSummary[] }
  | { kind: "ok"; projectId: string; jobs: RunBoxSummary[] }
  | { kind: "error"; projectId: string; message: string };

type EnvironmentsPanelProps = {
  webBaseUrl: string;
  deepLink?: DeepLinkParseResult | null;
  onDeepLinkHandled?: () => void;
};

function providerLabel(job: RunBoxSummary): string {
  const profile = job.profileId ? ` · ${job.profileId}` : "";
  return `${job.provider}${profile}`;
}

function formatTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function DeviceKeyLine({ status }: { status: DeviceKeyStatus | null }) {
  if (!status) {
    return (
      <p className="brand-meta" role="status">
        Checking this device's SSH key…
      </p>
    );
  }
  const tone =
    status.state === "registered"
      ? "green"
      : status.state === "error"
        ? "pink"
        : "cyan";
  return (
    <div className="device-key" role="status">
      <span className={`tag ${tone}`}>
        {status.state === "registered"
          ? "Device key registered"
          : status.state === "registering"
            ? "Registering device key"
            : status.state === "error"
              ? "Device key not registered"
              : "Device key pending"}
      </span>
      <span className="device-key-detail">
        {status.label ? `${status.label} · ` : ""}
        {status.fingerprint ?? "no key yet"}
      </span>
      <span className="device-key-detail">{status.message}</span>
    </div>
  );
}

/**
 * Environments (HAC-90): run boxes for a project from GET /api/run-boxes, with
 * honest server states and an in-app SSH terminal for ready environments.
 * Host, port, and host key come from the authenticated connection API only.
 */
export function EnvironmentsPanel({
  webBaseUrl,
  deepLink = null,
  onDeepLinkHandled,
}: EnvironmentsPanelProps) {
  const [projects, setProjects] = useState<ProjectsLoad>({ kind: "loading" });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobsLoad>({ kind: "idle" });
  const [deviceKey, setDeviceKey] = useState<DeviceKeyStatus | null>(null);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [terminalFor, setTerminalFor] = useState<RunBoxSummary | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(
    null,
  );

  const loadProjects = useCallback(async () => {
    setProjects({ kind: "loading" });
    try {
      const state = await getState();
      setProjects({ kind: "ok", state });
      setProjectId((current) =>
        current && state.projects.some((project) => project.id === current)
          ? current
          : (state.projects[0]?.id ?? null),
      );
    } catch (error) {
      setProjects({
        kind: "error",
        message: ipcErrorMessage(error, "Could not load projects."),
      });
    }
  }, []);

  const loadJobs = useCallback(async (targetProjectId: string) => {
    setJobs((current) => ({
      kind: "loading",
      projectId: targetProjectId,
      previous:
        current.kind === "ok" && current.projectId === targetProjectId
          ? current.jobs
          : [],
    }));
    try {
      const list = await desktopApi().listRunBoxes(targetProjectId);
      setJobs((current) =>
        current.kind === "loading" && current.projectId !== targetProjectId
          ? current
          : { kind: "ok", projectId: targetProjectId, jobs: list },
      );
    } catch (error) {
      setJobs((current) =>
        current.kind === "loading" && current.projectId !== targetProjectId
          ? current
          : {
              kind: "error",
              projectId: targetProjectId,
              message: ipcErrorMessage(error, "Could not load environments."),
            },
      );
    }
  }, []);

  const refreshDeviceKey = useCallback(async () => {
    try {
      setDeviceKey(await desktopApi().deviceKeyStatus());
    } catch (error) {
      setDeviceKey({
        state: "error",
        fingerprint: null,
        label: null,
        persistent: false,
        message: ipcErrorMessage(error, "Device key status unavailable."),
      });
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    void refreshDeviceKey();
  }, [loadProjects, refreshDeviceKey]);

  useEffect(() => {
    if (!projectId) {
      setJobs({ kind: "idle" });
      return;
    }
    void loadJobs(projectId);
  }, [projectId, loadJobs]);

  // Deep link: select the project, then wait for the listing to confirm ready.
  useEffect(() => {
    if (!deepLink || projects.kind !== "ok") return;
    onDeepLinkHandled?.();
    if (!deepLink.ok) {
      setNotice({ tone: "error", text: deepLink.error });
      return;
    }
    const { projectId: linkProject, runBoxId } = deepLink.target;
    const project = projects.state.projects.find((row) => row.id === linkProject);
    if (!project) {
      setNotice({
        tone: "error",
        text: `Deep link project ${linkProject} was not found. Create or join it on the web, then retry.`,
      });
      return;
    }
    setNotice(null);
    setProjectId(project.id);
    if (runBoxId) {
      setPendingOpen(runBoxId);
      if (project.id === projectId) void loadJobs(project.id);
    }
  }, [deepLink, projects, projectId, loadJobs, onDeepLinkHandled]);

  const jobList =
    jobs.kind === "ok" ? jobs.jobs : jobs.kind === "loading" ? jobs.previous : [];

  // Resolve a pending auto-open once the listing for its project arrives.
  useEffect(() => {
    if (!pendingOpen || jobs.kind !== "ok" || jobs.projectId !== projectId) return;
    const job = jobs.jobs.find((row) => row.id === pendingOpen);
    if (!job) {
      setNotice({
        tone: "error",
        text: `Environment ${pendingOpen} was not found on this project.`,
      });
      setPendingOpen(null);
      return;
    }
    if (canOpenTerminal(job)) {
      setNotice(null);
      setTerminalFor(job);
      setPendingOpen(null);
      return;
    }
    if (isTransitional(job) && !job.stopRequested) {
      setNotice({
        tone: "info",
        text: `Waiting for environment ${job.id} to become ready (currently ${runBoxStateLabel(job).toLowerCase()}). The terminal opens automatically.`,
      });
      return;
    }
    setNotice({
      tone: "error",
      text: terminalBlockedReason(job) ?? `Environment ${job.id} cannot open a terminal.`,
    });
    setPendingOpen(null);
  }, [jobs, pendingOpen, projectId]);

  // Poll while something is in flight so states stay honest.
  const shouldPoll =
    projectId !== null &&
    jobs.kind === "ok" &&
    (pendingOpen !== null || jobs.jobs.some(isTransitional));
  useEffect(() => {
    if (!shouldPoll || !projectId) return;
    const timer = window.setTimeout(() => {
      void loadJobs(projectId);
    }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [shouldPoll, projectId, jobs, loadJobs]);

  const projectList = projects.kind === "ok" ? projects.state.projects : [];

  return (
    <main className="tasks-panel" aria-labelledby="environments-heading">
      <div className="tasks-panel-header">
        <div>
          <h1 id="environments-heading">Environments</h1>
          <p className="tasks-lead">
            Run boxes created on the web for this project. SSH here is trusted
            shell access to the environment — it is not a filesystem or command
            sandbox. Desktop does not create or stop environments.
          </p>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => {
            void loadProjects();
            void refreshDeviceKey();
            if (projectId) void loadJobs(projectId);
          }}
          disabled={projects.kind === "loading"}
        >
          {projects.kind === "loading" ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <DeviceKeyLine status={deviceKey} />

      {notice ? (
        <p
          className={notice.tone === "error" ? "error-banner" : "brand-meta"}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.text}
        </p>
      ) : null}

      {projects.kind === "error" ? (
        <div className="app-error" role="alert">
          <h2>Cannot load projects</h2>
          <p>{projects.message}</p>
          <p>
            Keep the web app running at <code>{webBaseUrl}</code>, then refresh.
          </p>
        </div>
      ) : null}

      {projects.kind === "loading" ? (
        <p className="auth-loading" role="status">
          Loading projects from {webBaseUrl}…
        </p>
      ) : null}

      {projects.kind === "ok" && projectList.length === 0 ? (
        <div className="tasks-empty" role="status">
          <h2>No projects yet</h2>
          <p>
            Create a project on the web at <code>{webBaseUrl}</code>, then create
            an environment from its Environments page.
          </p>
        </div>
      ) : null}

      {projectList.length > 0 ? (
        <div className="environments-layout">
          <label className="picker-select">
            <span>Project</span>
            <select
              className="control-select"
              aria-label="Project"
              value={projectId ?? ""}
              onChange={(event) => {
                setPendingOpen(null);
                setNotice(null);
                setProjectId(event.target.value || null);
              }}
            >
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>

          {jobs.kind === "error" ? (
            <p className="error-banner" role="alert">
              {jobs.message}
            </p>
          ) : null}

          {jobs.kind === "loading" && jobList.length === 0 ? (
            <p className="auth-loading" role="status">
              Loading environments…
            </p>
          ) : null}

          {jobs.kind === "ok" && jobList.length === 0 ? (
            <div className="tasks-empty" role="status">
              <h2>No environments</h2>
              <p>
                This project has no run boxes. Create one on the web
                Environments page, then use Open in desktop or refresh here.
              </p>
            </div>
          ) : null}

          {jobList.length > 0 ? (
            <ul className="environment-list" aria-label="Environments">
              {jobList.map((job) => {
                const blocked = terminalBlockedReason(job);
                const created = formatTime(job.createdAt);
                const active = terminalFor?.id === job.id;
                return (
                  <li key={job.id} className="environment-row" data-active={active ? "true" : "false"}>
                    <div className="detail-row">
                      <span className="detail-primary">{providerLabel(job)}</span>
                      <span className={`tag ${runBoxStateTone(job)}`} title={job.rawState}>
                        {runBoxStateLabel(job)}
                      </span>
                      <span className="tag yellow">Trusted shell access</span>
                    </div>
                    <span className="detail-secondary">
                      {[
                        `id ${job.id}`,
                        job.ssh
                          ? `ssh ${job.ssh.username}@${job.ssh.host}:${job.ssh.port}`
                          : "no SSH endpoint yet",
                        job.maxDurationMinutes ? `${job.maxDurationMinutes} min max` : null,
                        created ? `created ${created}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <div className="environment-actions">
                      <button
                        type="button"
                        className="button primary"
                        disabled={blocked !== null}
                        aria-describedby={blocked ? `blocked-${job.id}` : undefined}
                        onClick={() => {
                          setNotice(null);
                          setTerminalFor(job);
                        }}
                      >
                        {active ? "Terminal open" : "Open terminal"}
                      </button>
                      {blocked ? (
                        <span className="detail-secondary" id={`blocked-${job.id}`}>
                          {blocked}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}

      {terminalFor ? (
        <TerminalPanel
          key={terminalFor.id}
          runBoxId={terminalFor.id}
          title={`${providerLabel(terminalFor)} · ${terminalFor.id}`}
          onClose={() => setTerminalFor(null)}
        />
      ) : null}
    </main>
  );
}
