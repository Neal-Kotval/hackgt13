import { useCallback, useEffect, useState } from "react";
import { TaskComposer } from "./TaskComposer";
import { getState } from "../lib/server-api";
import type { AgentCloudStateSummary, ProjectSnapshot } from "../lib/types";

type ProjectPickerProps = {
  webBaseUrl: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; state: AgentCloudStateSummary }
  | { kind: "error"; message: string };

function hasVerifiedResource(project: ProjectSnapshot): boolean {
  return project.resources.some((resource) => resource.status === "verified");
}

export function ProjectPicker({ webBaseUrl }: ProjectPickerProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const state = await getState();
      setLoad({ kind: "ok", state });
      setSelectedId((current) => {
        if (current && state.projects.some((project) => project.id === current)) {
          return current;
        }
        return state.projects[0]?.id ?? null;
      });
    } catch (error) {
      setLoad({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not reach AgentCloud state API.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selected =
    load.kind === "ok"
      ? load.state.projects.find((project) => project.id === selectedId) ?? null
      : null;

  return (
    <main className="tasks-panel" aria-labelledby="tasks-heading">
      <div className="tasks-panel-header">
        <div>
          <h1 id="tasks-heading">Tasks</h1>
          <p className="tasks-lead">
            Select a project and inspect environments from the shared backend.
            Desktop does not create machines — connect and verify on the web
            first.
          </p>
        </div>
        <button
          type="button"
          className="button ghost"
          onClick={() => {
            void refresh();
          }}
          disabled={load.kind === "loading"}
        >
          {load.kind === "loading" ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {load.kind === "error" ? (
        <div className="app-error" role="alert">
          <h2>Cannot load projects</h2>
          <p>{load.message}</p>
          <p>
            Keep the web app running at <code>{webBaseUrl}</code>, then refresh.
          </p>
        </div>
      ) : null}

      {load.kind === "loading" ? (
        <p className="auth-loading" role="status">
          Loading projects from {webBaseUrl}…
        </p>
      ) : null}

      {load.kind === "ok" && load.state.projectCount === 0 ? (
        <div className="tasks-empty" role="status">
          <h2>No projects yet</h2>
          <p>
            Nothing is seeded here. In the web app at{" "}
            <code>{webBaseUrl}</code>, create a project and use{" "}
            <strong>Connect a machine</strong> to register or verify an
            environment. Then refresh this panel.
          </p>
          <p className="tasks-aside">
            Revision {load.state.revision}. Task composer UI is not available
            yet — this picker is read-only.
          </p>
        </div>
      ) : null}

      {load.kind === "ok" && load.state.projectCount > 0 ? (
        <div className="picker-layout">
          <label className="picker-select">
            <span>Project</span>
            <select
              className="control-select"
              aria-label="Project"
              value={selectedId ?? ""}
              onChange={(event) => setSelectedId(event.target.value || null)}
            >
              {load.state.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <p className="brand-meta">
            Shared backend revision {load.state.revision} ·{" "}
            {load.state.projectCount} project
            {load.state.projectCount === 1 ? "" : "s"}
          </p>

          {selected ? (
            <>
              <ProjectDetail project={selected} webBaseUrl={webBaseUrl} />
              <TaskComposer
                key={selected.id}
                project={selected}
                webBaseUrl={webBaseUrl}
                onCreated={() => refresh()}
              />
            </>
          ) : null}
        </div>
      ) : null}

      <div className="tasks-empty tasks-aside-panel" role="note">
        <h2>Machine-first reminder</h2>
        <p>
          Connect and verify environments on the web first. Desktop authors
          tasks against the shared backend; Local chat does not create
          AgentCloud tasks.
        </p>
      </div>
    </main>
  );
}

function statusTagClass(status: string): string {
  switch (status) {
    case "verified":
      return "tag green";
    case "registered":
    case "pending":
    case "in_progress":
      return "tag cyan";
    case "failed":
    case "denied":
    case "blocked":
      return "tag pink";
    case "not_evaluated":
    default:
      return "tag yellow";
  }
}

function readableStatus(status: string): string {
  return status.replaceAll("_", " ");
}

function ProjectDetail({
  project,
  webBaseUrl,
}: {
  project: ProjectSnapshot;
  webBaseUrl: string;
}) {
  const verified = hasVerifiedResource(project);

  return (
    <section className="project-detail" aria-label={`Project ${project.name}`}>
      <div className="project-meta">
        <p>
          <span className="meta-label">Repo</span> {project.repo || "(none)"}
        </p>
        <p>
          <span className="meta-label">Template</span>{" "}
          {project.template || "(none)"}
        </p>
        <p>
          <span className="meta-label">Intended compute</span>{" "}
          {project.compute || "(unset)"}
          {project.host ? ` · host metadata: ${project.host}` : ""}
        </p>
        <p className="brand-meta">
          Intended compute / host metadata is not proof of SSH connectivity.
        </p>
      </div>

      {!verified ? (
        <p className="credential-banner" role="status">
          No verified environment on this project. Connect and verify a machine
          on the web ({webBaseUrl}) before expecting desktop task start.
        </p>
      ) : (
        <p className="brand-meta" role="status">
          At least one resource reports status <code>verified</code>. That is
          catalog verification evidence — not a claim that a run box is ready to
          start an agent from desktop yet.
        </p>
      )}

      <DetailList
        title="Resources / environments"
        empty="No resources registered. Use Connect a machine on the web."
        items={project.resources.map((resource) => ({
          id: resource.id,
          primary: resource.name,
          secondary: resource.kind,
          status: resource.status,
        }))}
      />

      <DetailList
        title="Resource requests"
        empty="No resource requests."
        items={project.resourceRequests.map((request) => ({
          id: request.id,
          primary: request.purpose,
          secondary: `decision ${request.decisionStatus}${
            request.decisionReason ? ` — ${request.decisionReason}` : ""
          }`,
          status: request.status,
        }))}
      />

      <DetailList
        title="Agents"
        empty="No agents on this project."
        items={project.agents.map((agent) => ({
          id: agent.id,
          primary: `${agent.name} (${agent.role})`,
          secondary: agent.lastSeen ? `last seen ${agent.lastSeen}` : undefined,
          status: agent.status,
        }))}
      />

      <DetailList
        title="Tasks (server)"
        empty="No tasks yet. Use Create task below."
        items={project.tasks.map((task) => ({
          id: task.id,
          primary: task.title,
          secondary: `owner ${task.owner}`,
          status: task.status,
        }))}
      />
    </section>
  );
}

function DetailList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: {
    id: string;
    primary: string;
    secondary?: string;
    status?: string;
  }[];
}) {
  return (
    <div className="detail-list">
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="brand-meta">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <div className="detail-row">
                <span className="detail-primary">{item.primary}</span>
                {item.status ? (
                  <span
                    className={statusTagClass(item.status)}
                    title={item.status}
                  >
                    {readableStatus(item.status)}
                  </span>
                ) : null}
              </div>
              {item.secondary ? (
                <span className="detail-secondary">{item.secondary}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
