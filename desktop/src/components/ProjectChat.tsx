import { useEffect, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../lib/desktop-api";
import type { DeepLinkParseResult, ProjectSnapshot } from "../lib/types";
import { Composer, type ChatAttachment } from "./Composer";
import { CodexConversation, type CodexEvent } from "./CodexConversation";
import "./ProjectChat.css";
import { ChatProjectPicker } from "./ChatProjectPicker";
import { ChatHistory } from "./ChatHistory";
import {
  canOpenTerminal,
  runBoxStateLabel,
  type RunBoxSummary,
} from "../lib/run-boxes";

type Session = {
  id: string;
  projectId: string;
  agentId: string;
  status:
    | "initializing"
    | "auth_required"
    | "ready"
    | "running"
    | "error"
    | "stopped";
  error: string | null;
  updatedAt?: string;
  createdAt?: string;
};
type Event = CodexEvent;
class CodexRequestError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await desktopApi().fetchHuman(
    path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  const result = JSON.parse(response.body);
  if (!response.ok)
    throw new CodexRequestError(
      result.error || `Request failed (${response.status})`,
      result.code,
    );
  return result as T;
}

export function ProjectChat({
  webBaseUrl,
  deepLink,
  onDeepLinkHandled,
  onSelectConversation,
  onOpenTerminal,
  children,
}: {
  webBaseUrl: string;
  deepLink: DeepLinkParseResult | null;
  onDeepLinkHandled: () => void;
  onSelectConversation?: () => void;
  onOpenTerminal?: (projectId: string, runBoxId: string) => void;
  children: (chat: {
    content: ReactNode;
    sidebar: (close: () => void) => ReactNode;
    busy: boolean;
  }) => ReactNode;
}) {
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [projectId, setProjectId] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [runBoxes, setRunBoxes] = useState<RunBoxSummary[]>([]);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<
    Record<string, ChatAttachment[]>
  >({});
  const [attaching, setAttaching] = useState(false);
  const choosing = useRef(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<{
    session: Session;
    events: Event[];
  } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState<Record<string, boolean>>({});
  const blockAutoProject = useRef(false);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const [linkRevision, setLinkRevision] = useState(0);
  const desiredSession = useRef<string | null>(null);
  const lastProject = useRef("");
  // Preserve request identity on ambiguous network failures; backend deduplicates retries.
  const pending = useRef<Record<string, { text: string; requestId: string }>>(
    {},
  );
  useEffect(() => {
    let cancelled = false;
    desktopApi()
      .getState()
      .then((state) => {
        if (cancelled) return;
        setProjects(state.projects);
        if (deepLink?.ok) {
          if (!state.projects.some((p) => p.id === deepLink.target.projectId)) {
            blockAutoProject.current = true;
            desiredSession.current = deepLink.target.codexSessionId || null;
            setProjectId("");
            setSessionId("");
            setSnapshot(null);
            setSessions([]);
            setActionError(
              "The linked project is not available to your account. Choose a project explicitly to continue.",
            );
            setLoading(false);
            onDeepLinkHandled();
            return;
          }
          choosing.current = false;
          blockAutoProject.current = false;
          desiredSession.current = deepLink.target.codexSessionId || null;
          setProjectId(deepLink.target.projectId);
          setLinkRevision((value) => value + 1);
        } else if (!blockAutoProject.current)
          setProjectId((current) => current || state.projects[0]?.id || "");
        setError(null);
        setLoading(false);
        onDeepLinkHandled();
      })
      .catch((err) => {
        if (!cancelled) {
          setLoading(false);
          setError(err.message);
          onDeepLinkHandled();
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deepLink, onDeepLinkHandled, retry]);
  useEffect(() => {
    if (lastProject.current !== projectId || desiredSession.current) {
      setSessions([]);
      setSessionId("");
      setSnapshot(null);
      lastProject.current = projectId;
    }
    if (!projectId) {
      setLoading(false);
      return;
    }
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    setActionError(null);
    const poll = async () => {
      try {
        const data = await request<{ enabled: boolean; sessions: Session[] }>(
          `/api/codex-sessions?projectId=${encodeURIComponent(projectId)}`,
        );
        if (cancelled) return;
        setSessions(data.sessions);
        setEnabled(data.enabled);
        setError(null);
        const requested = desiredSession.current;
        if (requested) {
          if (data.sessions.some((s) => s.id === requested)) {
            desiredSession.current = null;
            setSessionId(requested);
            setActionError(null);
          } else
            setActionError(
              "The linked Codex session is not available in this project.",
            );
        } else if (!choosing.current)
          setSessionId((current) =>
            data.sessions.some((s) => s.id === current)
              ? current
              : data.sessions[0]?.id || "",
          );
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error
              ? err.message
              : "Could not load Codex sessions.",
          );
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(poll, 1000);
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, retry, linkRevision]);
  useEffect(() => {
    setRunBoxes([]);
    setEnvironmentError(null);
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const boxes = await desktopApi().listRunBoxes(projectId);
        if (!cancelled) {
          setRunBoxes(boxes.filter((box) => box.projectId === projectId));
          setEnvironmentError(null);
        }
      } catch {
        if (!cancelled) {
          setRunBoxes([]);
          setEnvironmentError("Environment list unavailable.");
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectId, retry]);
  useEffect(() => {
    setSnapshot(null);
    if (!sessionId) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request<{ session: Session; events: Event[] }>(
          `/api/codex-sessions/${encodeURIComponent(sessionId)}`,
        );
        if (!cancelled && data.session.projectId === projectId) {
          setSnapshot(data);
          setError(null);
          const first = data.events.find((event) => event.kind === "user");
          if (first)
            setTitles((current) => ({
              ...current,
              [data.session.id]: first.text.split("\n")[0],
            }));
        }
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "Could not refresh session.",
          );
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, projectId, retry]);
  const session =
    snapshot?.session.id === sessionId &&
    snapshot.session.projectId === projectId
      ? snapshot.session
      : undefined;
  const draftKey = sessionId || `project:${projectId}`;
  const draft = drafts[draftKey] || "";
  const draftAttachments = attachments[draftKey] || [];
  const messageText = [
    draft.trim(),
    ...draftAttachments.map(
      (file) => `Attached context: ${file.name}\n${file.text}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
  async function attachFiles(files: File[]) {
    const key = draftKey;
    setAttaching(true);
    setActionError(null);
    try {
      if (files.length + draftAttachments.length > 8)
        throw new Error("Attach up to 8 text files per message.");
      const added = await Promise.all(
        files.map(async (file) => {
          if (file.size > 16000)
            throw new Error(
              `${file.name} is too large. Attach a text file under 16 KB.`,
            );
          const text = await file.text();
          if (
            text.includes("\0") ||
            (!file.type.startsWith("text/") &&
              !/\.(md|txt|json|[cm]?js|jsx|tsx?|py|css|html|csv|ya?ml|toml|sh|sql|log)$/i.test(
                file.name,
              ))
          )
            throw new Error(`${file.name} is not a supported text file.`);
          return { id: crypto.randomUUID(), name: file.name, text };
        }),
      );
      setAttachments((current) => ({
        ...current,
        [key]: [...(current[key] || []), ...added],
      }));
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Could not read the attachment.",
      );
    } finally {
      setAttaching(false);
    }
  }
  async function act(
    action: "message" | "interrupt" | "resume",
    asNewTurn = false,
    retryText?: string,
  ) {
    if (
      busy ||
      !sessionId ||
      (action === "message" && ambiguous[sessionId] && !asNewTurn)
    )
      return;
    const id = sessionId,
      key = draftKey,
      text = retryText ?? messageText;
    if (action === "message" && (!text || text.length > 16000)) {
      setActionError(
        "Keep the message and attached context within 16,000 characters.",
      );
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      let body: object = { action };
      if (action === "message") {
        const prior = pending.current[id];
        const turn =
          !asNewTurn && prior?.text === text
            ? prior
            : { text, requestId: crypto.randomUUID() };
        pending.current[id] = turn;
        body = { action, ...turn };
      }
      const result = await request<{ session: Session }>(
        `/api/codex-sessions/${encodeURIComponent(id)}`,
        body,
      );
      setSnapshot((current) =>
        current?.session.id === id
          ? { ...current, session: result.session }
          : current,
      );
      if (action === "message") {
        setAmbiguous((current) => ({ ...current, [id]: false }));
        delete pending.current[id];
        if (retryText === undefined || messageText === text) {
          setDrafts((current) => ({
            ...current,
            [key]: current[key] === draft ? "" : current[key],
          }));
          setAttachments((current) => ({ ...current, [key]: [] }));
        }
      }
    } catch (err) {
      if (err instanceof CodexRequestError && err.code === "ambiguous_turn")
        setAmbiguous((current) => ({ ...current, [id]: true }));
      setActionError(
        err instanceof Error ? err.message : "Could not update Codex session.",
      );
    } finally {
      setBusy(false);
    }
  }
  const project = projects.find((p) => p.id === projectId);
  const agentName = (item: Session) =>
    project?.agents.find((a) => a.id === item.agentId)?.name || "Codex";
  const statusLabel = {
    initializing: "Starting",
    auth_required: "Sign-in required",
    ready: "Ready",
    running: "Working",
    error: "Needs attention",
    stopped: "Stopped",
  };
  const settingsUrl = projectId
    ? `${webBaseUrl}/projects/${encodeURIComponent(projectId)}/settings`
    : webBaseUrl;
  const messages = session ? (snapshot?.events ?? []) : [];
  const hasConversation = messages.some(
    (event) => event.kind === "user" || event.kind === "assistant",
  );
  const recoveryText = pending.current[sessionId]?.text ?? messageText;
  const working = session?.status === "running";
  const environmentTone = !session
    ? "muted"
    : session.status === "ready"
      ? "success"
      : session.status === "error"
        ? "danger"
        : "warning";
  function chooseProject(id: string) {
    blockAutoProject.current = true;
    desiredSession.current = null;
    choosing.current = false;
    setActionError(null);
    setProjectId(id);
    setSessionId("");
    setSnapshot(null);
    onSelectConversation?.();
  }
  function chooseAgent(id: string) {
    desiredSession.current = null;
    choosing.current = !id;
    setSessionId(id);
    setActionError(null);
    onSelectConversation?.();
  }
  const context = (variant: "empty" | "header" | "toolbar") => (
    <ChatProjectPicker
      variant={variant}
      projectId={projectId}
      sessionId={sessionId}
      projects={projects.map((p) => ({ value: p.id, label: p.name }))}
      agents={sessions.map((item) => ({
        value: item.id,
        label: agentName(item),
      }))}
      environments={[
        ...(session
          ? [
              {
                value: "session",
                label: "Local Docker",
                status: statusLabel[session.status],
              },
            ]
          : []),
        ...runBoxes.map((box) => ({
          value: box.id,
          label: `${box.profileId || box.id} · SSH terminal`,
          status: runBoxStateLabel(box),
          disabled: !canOpenTerminal(box),
        })),
      ]}
      environmentValue={session ? "session" : ""}
      environmentTone={environmentTone}
      disabled={busy || attaching}
      onProject={chooseProject}
      onAgent={chooseAgent}
      onEnvironment={(id) => {
        if (id && id !== "session") onOpenTerminal?.(projectId, id);
      }}
    />
  );
  const firstUser = messages.find((event) => event.kind === "user");
  const title = hasConversation
    ? firstUser?.text.split("\n")[0] ||
      (session ? agentName(session) : "Project chat")
    : "New chat";
  const sidebar = (close: () => void) => (
    <ChatHistory
      threads={sessions.map((item) => ({
        id: item.id,
        title: titles[item.id] || agentName(item),
        updatedAt: item.updatedAt,
        status: item.status,
      }))}
      selectedId={sessionId}
      busy={busy || attaching}
      loading={loading}
      setupUrl={settingsUrl}
      onSelect={(id) => {
        chooseAgent(id);
        close();
      }}
      onCreate={() => {
        choosing.current = true;
        desiredSession.current = null;
        setSessionId("");
        setSnapshot(null);
        setActionError(null);
        onSelectConversation?.();
        close();
      }}
    />
  );
  const content = (
    <div className="app-shell">
      <main className="main project-chat-main" data-empty={!hasConversation}>
        <header className="main-header">
          <h1 title={title}>{title}</h1>
          <div className="project-chat-status">
            {hasConversation && context("header")}
            {session && ["error", "stopped"].includes(session.status) && (
              <button
                className="button ghost"
                disabled={busy}
                onClick={() => void act("resume")}
              >
                Reconnect
              </button>
            )}
          </div>
        </header>
        <CodexConversation
          key={sessionId || "empty"}
          events={messages}
          working={working}
          agentName={session ? agentName(session) : "Codex"}
          environmentName="Local Docker"
          retryDisabled={
            busy ||
            attaching ||
            session?.status !== "ready" ||
            Boolean(ambiguous[sessionId])
          }
          onRetry={(eventId) => {
            const index = messages.findIndex((event) => event.id === eventId);
            const previous = messages
              .slice(0, index)
              .reverse()
              .find((event) => event.kind === "user");
            if (previous) void act("message", false, previous.text);
          }}
          emptyContent={
            <div className="chat-context-empty-state">
              {context("empty")}
              <p>
                {loading
                  ? "Loading your conversation…"
                  : !project
                    ? "Choose a project to get started."
                    : !enabled
                      ? "Local Codex is not enabled on this server."
                      : !sessions.length
                        ? "Connect an agent in project Settings to begin."
                        : !sessionId
                          ? "Choose an agent to open its conversation."
                          : "Replies come from this project's agent via alto."}
              </p>
            </div>
          }
        />
        <div className="chat-compose-area">
          {error && (
            <p className="error-banner" role="alert">
              {error}{" "}
              <button
                className="button ghost"
                onClick={() => setRetry((n) => n + 1)}
              >
                Retry connection
              </button>
            </p>
          )}
          {environmentError && (
            <p className="credential-banner" role="status">
              {environmentError}{" "}
              <button
                className="button ghost"
                onClick={() => setRetry((n) => n + 1)}
              >
                Refresh environments
              </button>
            </p>
          )}
          {session?.error && (
            <p className="error-banner" role="alert">
              {session.error}
            </p>
          )}
          {session?.status === "auth_required" && (
            <p className="credential-banner">
              Finish signing in to Codex in{" "}
              <a href={settingsUrl} target="_blank" rel="noreferrer">
                project Settings
              </a>
              .
            </p>
          )}
          {!sessions.length && !loading && (
            <a
              className="button primary"
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Set up agent on website
            </a>
          )}
          {ambiguous[sessionId] && (
            <div className="project-chat-recovery" role="status">
              <p>
                The previous send could not be confirmed. Check the conversation
                after reconnecting before sending it again.
              </p>
              <button
                className="button warning"
                disabled={
                  busy || session?.status !== "ready" || !recoveryText.trim()
                }
                onClick={() => void act("message", true, recoveryText)}
              >
                Send as a new turn
              </button>
            </div>
          )}
          <Composer
            value={draft}
            disabled={!session || busy || attaching}
            sendDisabled={
              session?.status !== "ready" || Boolean(ambiguous[sessionId])
            }
            sending={working}
            error={actionError}
            placeholder={
              session
                ? hasConversation
                  ? `Message ${agentName(session)}`
                  : `Ask ${agentName(session)} to work on ${project?.name || "this project"}`
                : "Choose an agent to start chatting"
            }
            context={hasConversation ? context("toolbar") : undefined}
            attachments={draftAttachments}
            onAttach={(files) => void attachFiles(files)}
            onRemoveAttachment={(id) =>
              setAttachments((current) => ({
                ...current,
                [draftKey]: (current[draftKey] || []).filter(
                  (file) => file.id !== id,
                ),
              }))
            }
            onChange={(value) =>
              setDrafts((current) => ({ ...current, [draftKey]: value }))
            }
            onSend={() => void act("message")}
            onStop={() => void act("interrupt")}
          />
        </div>
      </main>
    </div>
  );
  return children({ content, sidebar, busy: busy || attaching || working });
}
