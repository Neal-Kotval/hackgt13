import { useCallback, useEffect, useState } from "react";
import { getState } from "../lib/server-api";
import type { ProjectSnapshot } from "../lib/types";

type ChatProjectPickerProps = {
  selectedId: string | null;
  onSelect: (updater: (current: string | null) => string | null) => void;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; projects: ProjectSnapshot[] }
  | { kind: "error"; message: string };

export function ChatProjectPicker({
  selectedId,
  onSelect,
}: ChatProjectPickerProps) {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });

  const refresh = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      const state = await getState();
      setLoad({ kind: "ok", projects: state.projects });
      onSelect((current) => {
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
            : "Could not load projects for chat.",
      });
    }
  }, [onSelect]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (load.kind === "loading") {
    return (
      <p className="brand-meta" role="status">
        Loading projects…
      </p>
    );
  }

  if (load.kind === "error") {
    return (
      <p className="error-banner" role="alert">
        {load.message}{" "}
        <button type="button" className="button ghost" onClick={() => void refresh()}>
          Retry
        </button>
      </p>
    );
  }

  if (load.projects.length === 0) {
    return (
      <p className="credential-banner" role="status">
        Create a project on the web first. Chat talks to a project agent — there
        is nothing to bind yet.
      </p>
    );
  }

  const selected = load.projects.find((project) => project.id === selectedId);
  const agentHint =
    selected && selected.agents.length === 0
      ? "No agents yet — the first send provisions a desktop-chat agent identity on the server."
      : selected
        ? `${selected.agents.length} agent${selected.agents.length === 1 ? "" : "s"} on this project.`
        : "Select a project to chat with its agent.";

  return (
    <div className="chat-project-picker">
      <label className="composer-hint" htmlFor="chat-project">
        Project agent
      </label>
      <select
        id="chat-project"
        className="control-select"
        value={selectedId ?? ""}
        onChange={(event) => {
          const next = event.target.value || null;
          onSelect(() => next);
        }}
      >
        {load.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <p className="brand-meta">{agentHint}</p>
    </div>
  );
}
