import { useState, type FormEvent } from "react";
import { buildAddTaskPayload } from "../lib/add-task";
import { describeAgentStartAvailability } from "../lib/agent-start";
import { postAction } from "../lib/server-api";
import type { ProjectSnapshot } from "../lib/types";

type TaskComposerProps = {
  project: ProjectSnapshot;
  webBaseUrl: string;
  preferredEnvironmentId?: string;
  onCreated: () => void | Promise<void>;
};

export function TaskComposer({
  project,
  webBaseUrl,
  preferredEnvironmentId,
  onCreated,
}: TaskComposerProps) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agentId, setAgentId] = useState(project.agents[0]?.id ?? "");
  const [environmentId, setEnvironmentId] = useState(
    preferredEnvironmentId ||
      project.resources.find((resource) => resource.status === "verified")?.id ||
      project.resources[0]?.id ||
      "",
  );
  const [startTaskId, setStartTaskId] = useState(
    project.tasks.at(-1)?.id ?? "",
  );
  const [startEnvironmentId, setStartEnvironmentId] = useState(
    preferredEnvironmentId ||
      project.resources.find((resource) => resource.status === "verified")?.id ||
      "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const verifiedEnvironments = project.resources.filter(
    (resource) => resource.status === "verified",
  );
  const canStartLater = verifiedEnvironments.length > 0;
  const startEnvironment = project.resources.find(
    (resource) => resource.id === startEnvironmentId,
  );
  const startAvailability = describeAgentStartAvailability({
    taskId: startTaskId,
    environmentId: startEnvironmentId,
    environmentStatus: startEnvironment?.status,
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const beforeIds = new Set(project.tasks.map((task) => task.id));
      const payload = buildAddTaskPayload({
        projectId: project.id,
        title,
        instructions,
        agentId,
        environmentId,
      });
      const result = await postAction(payload);
      const updated = result.state.projects.find((row) => row.id === project.id);
      const created = updated?.tasks.find((task) => !beforeIds.has(task.id));
      setTitle("");
      setInstructions("");
      if (created) {
        setStartTaskId(created.id);
        if (created.environmentId) {
          setStartEnvironmentId(created.environmentId);
        } else if (environmentId) {
          setStartEnvironmentId(environmentId);
        }
        setNotice(
          `Created task ${created.id} on the shared backend (revision ${result.state.revision}). Confirm the same id in the web app at ${webBaseUrl}. Start agent stays unavailable until a remote runner exists.`,
        );
      } else {
        setNotice(
          `Task created on the shared backend (revision ${result.state.revision}). Refresh the web app at ${webBaseUrl} to confirm.`,
        );
      }
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create task");
    } finally {
      setPending(false);
    }
  }

  if (project.agents.length === 0) {
    return (
      <section className="task-composer" aria-labelledby="task-composer-title">
        <h2 id="task-composer-title">Create task</h2>
        <p className="tasks-empty" role="status">
          This project has no agents yet. Add an agent identity in the web app
          at <code>{webBaseUrl}</code>, then refresh desktop.
        </p>
      </section>
    );
  }

  return (
    <section className="task-composer" aria-labelledby="task-composer-title">
      <h2 id="task-composer-title">Create task</h2>
      <p className="brand-meta">
        Submits to the shared backend (<code>POST /api/state</code>{" "}
        <code>addTask</code>). Project chat is never a substitute for remote
        agent start.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="task-title">
          Title
          <input
            id="task-title"
            name="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={200}
            required
            disabled={pending}
          />
        </label>
        <label htmlFor="task-instructions">
          Instructions
          <textarea
            id="task-instructions"
            name="instructions"
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            rows={4}
            required
            disabled={pending}
          />
        </label>
        <label htmlFor="task-agent">
          Agent
          <select
            id="task-agent"
            className="control-select"
            aria-label="Agent"
            value={agentId}
            onChange={(event) => setAgentId(event.target.value)}
            required
            disabled={pending}
          >
            {project.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} ({agent.role}) · {agent.status}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="task-environment">
          Environment / resource
          <select
            id="task-environment"
            className="control-select"
            aria-label="Environment"
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.target.value)}
            disabled={pending || project.resources.length === 0}
          >
            {project.resources.length === 0 ? (
              <option value="">
                None registered — connect a machine on the web
              </option>
            ) : (
              project.resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name} · {resource.kind} · {resource.status}
                </option>
              ))
            )}
          </select>
        </label>
        {!canStartLater ? (
          <p className="credential-banner" role="status">
            No verified environment on this project. You can still create a
            queued task, but Start agent stays unavailable until the web app
            verifies a machine.
          </p>
        ) : (
          <p className="brand-meta" role="status">
            A verified resource is available to bind on create. Starting an
            agent still requires a remote runner API.
          </p>
        )}
        <div className="composer-actions">
          <button
            type="submit"
            className="button primary"
            disabled={
              pending || !title.trim() || !instructions.trim() || !agentId
            }
          >
            {pending ? "Creating…" : "Create task"}
          </button>
        </div>
      </form>

      <div
        className="task-start-panel"
        aria-labelledby="task-start-title"
        role="group"
      >
        <h3 id="task-start-title">Start agent</h3>
        <p className="brand-meta">
          Request a server-authorized start against a created task and verified
          environment. Project chat does not start AgentCloud agents.
        </p>
        <label htmlFor="start-task">
          Task
          <select
            id="start-task"
            className="control-select"
            aria-label="Task to start"
            value={startTaskId}
            onChange={(event) => setStartTaskId(event.target.value)}
            disabled={project.tasks.length === 0}
          >
            {project.tasks.length === 0 ? (
              <option value="">Create a task first</option>
            ) : (
              project.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title} · {task.status}
                </option>
              ))
            )}
          </select>
        </label>
        <label htmlFor="start-environment">
          Verified environment
          <select
            id="start-environment"
            className="control-select"
            aria-label="Environment for agent start"
            value={startEnvironmentId}
            onChange={(event) => setStartEnvironmentId(event.target.value)}
            disabled={verifiedEnvironments.length === 0}
          >
            {verifiedEnvironments.length === 0 ? (
              <option value="">No verified environment</option>
            ) : (
              verifiedEnvironments.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.name} · {resource.kind}
                </option>
              ))
            )}
          </select>
        </label>
        <p id="start-agent-reason" className="credential-banner" role="status">
          {startAvailability.reason}
        </p>
        <button
          type="button"
          className="button primary"
          disabled
          aria-describedby="start-agent-reason"
          title={startAvailability.reason}
        >
          Start agent
        </button>
      </div>

      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="auth-notice" role="status">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
