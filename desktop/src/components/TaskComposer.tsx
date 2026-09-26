import { useState, type FormEvent } from "react";
import { buildAddTaskPayload } from "../lib/add-task";
import { postAction } from "../lib/server-api";
import type { ProjectSnapshot } from "../lib/types";

type TaskComposerProps = {
  project: ProjectSnapshot;
  webBaseUrl: string;
  onCreated: () => void | Promise<void>;
};

export function TaskComposer({
  project,
  webBaseUrl,
  onCreated,
}: TaskComposerProps) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [agentId, setAgentId] = useState(project.agents[0]?.id ?? "");
  const [environmentId, setEnvironmentId] = useState(
    project.resources[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const verifiedEnvironments = project.resources.filter(
    (resource) => resource.status === "verified",
  );
  const canStartLater = verifiedEnvironments.length > 0;

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
      setNotice(
        created
          ? `Created task ${created.id} on the shared backend (revision ${result.state.revision}). Confirm the same id in the web app at ${webBaseUrl}.`
          : `Task created on the shared backend (revision ${result.state.revision}). Refresh the web app at ${webBaseUrl} to confirm.`,
      );
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
        <code>addTask</code>). Local chat threads are not tasks. Title,
        instructions, owner, and optional verified environment id are persisted
        on the server. Agent start stays unavailable until a runner exists.
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
            A verified resource exists for selection context, but desktop still
            does not start agents from this form.
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
          <button type="button" className="button ghost" disabled>
            Start agent (unavailable)
          </button>
        </div>
      </form>
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
