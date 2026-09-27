import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../lib/desktop-api";
import {
  deriveChatTargets,
  environmentLabel,
  parseCodexSession,
  parseCodexSessions,
  sessionForTarget,
  sessionTargetLabel,
  targetKey,
  type CodexSession,
} from "../lib/codex-targets";
import type { LoginTarget } from "../lib/browser-login-flow";
import type { DeepLinkParseResult, ProjectSnapshot } from "../lib/types";
import { Composer, type ChatAttachment } from "./Composer";
import { CodexConversation, type CodexEvent } from "./CodexConversation";
import "./ProjectChat.css";
import { ChatProjectPicker } from "./ChatProjectPicker";
import { ChatHistory } from "./ChatHistory";
import {
  canTargetCodex,
  codexBlockedReason,
  isTransitional,
  runBoxStateLabel,
  type RunBoxSummary,
} from "../lib/run-boxes";

type Session = CodexSession;
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
  onSignIn,
  children,
}: {
  webBaseUrl: string;
  deepLink: DeepLinkParseResult | null;
  onDeepLinkHandled: () => void;
  onSelectConversation?: () => void;
  onSignIn?: (target: LoginTarget) => void;
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
  const [runBoxesFor, setRunBoxesFor] = useState("");
  const [sessionsFor, setSessionsFor] = useState("");
  // Codex target with no session yet (picker value when nothing is selected).
  const [targetChoice, setTargetChoice] = useState("");
  const targetChoiceRef = useRef(targetChoice);
  targetChoiceRef.current = targetChoice;
  // Environment requested by a panel=codex link or Environments "Open chat".
  const [pendingEnvironment, setPendingEnvironment] = useState<string | null>(null);
  const pendingEnvironmentRef = useRef<string | null>(null);
  const [targetNotice, setTargetNotice] = useState<string | null>(null);
  const newChatRequests = useRef<Record<string, string>>({});
  const [setupRequired, setSetupRequired] = useState<Record<string, boolean>>({});
  const [attachments, setAttachments] = useState<
    Record<string, ChatAttachment[]>
  >({});
  const [attaching, setAttaching] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<{
    session: Session;
    events: Event[];
  } | null>(null);
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
  const requestEnvironment = useCallback((runBoxId: string | null) => {
    pendingEnvironmentRef.current = runBoxId;
    setPendingEnvironment(runBoxId);
    setTargetNotice(null);
  }, []);
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
            requestEnvironment(null);
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
          blockAutoProject.current = false;
          // Never fall back to the previous environment if this link cannot resolve.
          setTargetChoice("");
          targetChoiceRef.current = "";
          setSessionId("");
          setSnapshot(null);
          desiredSession.current = deepLink.target.codexSessionId || null;
          requestEnvironment(
            deepLink.target.runBoxId
              ? deepLink.target.runBoxId
              : null,
          );
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
  }, [deepLink, onDeepLinkHandled, retry, requestEnvironment]);
  useEffect(() => {
    if (
      lastProject.current !== projectId ||
      desiredSession.current ||
      pendingEnvironmentRef.current
    ) {
      setSessions([]);
      setSessionsFor("");
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
        const data = await request<{ enabled: boolean; sessions: unknown }>(
          `/api/codex-sessions?projectId=${encodeURIComponent(projectId)}`,
        );
        if (cancelled) return;
        const list = parseCodexSessions(data.sessions).filter(item => item.target.kind === "runBox");
        setSessions(list);
        setSessionsFor(projectId);
        setError(null);
        const requested = desiredSession.current;
        if (requested) {
          if (list.some((s) => s.id === requested)) {
            desiredSession.current = null;
            setSessionId(requested);
            setActionError(null);
          } else
            setActionError(
              "The linked Codex session is not available in this project.",
            );
        } else if (!pendingEnvironmentRef.current)
          setSessionId((current) => {
            if (list.some((s) => s.id === current)) return current;
            const selected = sessionForTarget(list, targetChoiceRef.current);
            return selected?.id || "";
          });
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
    setRunBoxesFor("");
    setEnvironmentError(null);
    if (!projectId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const boxes = await desktopApi().listRunBoxes(projectId);
        if (!cancelled) {
          setRunBoxes(boxes.filter((box) => box.projectId === projectId));
          setRunBoxesFor(projectId);
          setEnvironmentError(null);
        }
      } catch {
        if (!cancelled) {
          setRunBoxes([]);
          setRunBoxesFor(projectId);
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
  }, [projectId, retry, linkRevision]);
  useEffect(() => {
    setSnapshot(null);
    if (!sessionId) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request<{ session: unknown; events: Event[] }>(
          `/api/codex-sessions/${encodeURIComponent(sessionId)}`,
        );
        const parsed = parseCodexSession(data.session);
        if (!cancelled && parsed?.target.kind === "runBox" && parsed.projectId === projectId) {
          setSnapshot({ session: parsed, events: data.events });
          setError(null);
          const first = data.events.find((event) => event.kind === "user");
          if (first)
            setTitles((current) => ({
              ...current,
              [parsed.id]: first.text.split("\n")[0],
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
  const project = projects.find((p) => p.id === projectId);
  function codexAgentId(): string | null {
    const current = sessions.find((s) => s.id === sessionId)?.agentId;
    if (current) return current;
    if (sessions[0]?.agentId) return sessions[0].agentId;
    return (
      project?.agents.find((a) => a.client?.toLowerCase() === "codex")?.id ??
      null
    );
  }

  async function signInWithChatGpt() {
    if (!projectId || !selectedBox) return;
    const runBoxId = selectedBox.id;
    const existing = sessions.find((item) => item.isSetupSession !== false && item.target.kind === "runBox" && item.target.runBoxId === runBoxId && item.status === "auth_required")
      ?? (session?.status === "auth_required" && session.target.kind === "runBox" && session.target.runBoxId === runBoxId ? session : null);
    if (existing) {
      onSignIn?.({ projectId, runBoxId, codexSessionId: existing.id });
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await request<{ session: unknown }>("/api/codex-sessions", { projectId, runBoxId });
      const created = parseCodexSession(result.session);
      if (!created || created.target.kind !== "runBox" || created.target.runBoxId !== runBoxId)
        throw new Error("Could not prepare Codex on this environment.");
      setSessions((current) => [...current.filter((item) => item.id !== created.id), created]);
      setSessionId(created.id);
      setSetupRequired((current) => ({ ...current, [`runBox:${runBoxId}`]: false }));
      if (created.status === "auth_required") onSignIn?.({ projectId, runBoxId, codexSessionId: created.id });
      else setActionError("Codex is still connecting. Sign in with ChatGPT when this environment asks for it.");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start ChatGPT sign-in.");
    } finally {
      setBusy(false);
    }
  }

  async function openEnvironmentSession(runBoxId: string) {
    const agentId = codexAgentId();
    if (!projectId || !agentId) {
      setActionError(
        "Complete environment setup on the website before starting a chat.",
      );
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await request<{ session: unknown }>(
        "/api/codex-sessions",
        { projectId, agentId, runBoxId, newChat: true, requestId: newChatRequests.current[runBoxId] ??= crypto.randomUUID() },
      );
      const created = parseCodexSession(result.session);
      // Require the independent-chat contract; older servers may return the canonical setup session.
      if (!created || targetKey(created.target) !== `runBox:${runBoxId}` || created.isSetupSession !== false) {
        setActionError(
          "This alto server does not support independent environment chats yet. Update the server, then try again.",
        );
        return;
      }
      delete newChatRequests.current[runBoxId];
      setSetupRequired((current) => ({ ...current, [`runBox:${runBoxId}`]: false }));
      setSessions((current) => [
        ...current.filter((s) => s.id !== created.id),
        created,
      ]);
      setSessionId(created.id);
      onSelectConversation?.();
    } catch (err) {
      if (err instanceof CodexRequestError && err.code === "environment_setup_required")
        setSetupRequired((current) => ({ ...current, [`runBox:${runBoxId}`]: true }));
      setActionError(
        err instanceof Error
          ? err.message
          : "Could not start Codex on this environment.",
      );
    } finally {
      setBusy(false);
    }
  }

  // Resolve an environment request once sessions and environments are loaded.
  useEffect(() => {
    if (
      !pendingEnvironment ||
      !projectId ||
      sessionsFor !== projectId ||
      runBoxesFor !== projectId ||
      busy
    )
      return;
    const existing = sessionForTarget(sessions, `runBox:${pendingEnvironment}`);
    if (existing) {
      requestEnvironment(null);
      setTargetChoice(`runBox:${pendingEnvironment}`);
      setSessionId(existing.id);
      return;
    }
    const job = runBoxes.find((row) => row.id === pendingEnvironment);
    if (!job) {
      if (environmentError) return; // listing failed; keep waiting for the next poll
      requestEnvironment(null);
      setActionError(
        `Environment ${pendingEnvironment} was not found on this project.`,
      );
      return;
    }
    // Environment context is independent of whether Codex can execute yet.
    setTargetChoice(`runBox:${job.id}`);
    if (canTargetCodex(job)) {
      requestEnvironment(null);
      setTargetNotice("Sign in with ChatGPT to use Codex on this environment.");
      return;
    }
    if (
      (isTransitional(job) && !job.stopRequested) ||
      (job.state === "ready" && !job.stopRequested && job.codex?.state === "pending")
    ) {
      setTargetNotice(
        `Waiting for environment ${job.id} (${job.state === "ready" ? "checking Codex" : runBoxStateLabel(job).toLowerCase()}). Codex opens automatically.`,
      );
      return;
    }
    requestEnvironment(null);
    setActionError(
      codexBlockedReason(job) ?? `Codex cannot run on environment ${job.id}.`,
    );
    // openEnvironmentSession reads the current render; rerunning on its identity would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEnvironment, projectId, sessions, sessionsFor, runBoxes, runBoxesFor, busy, environmentError, requestEnvironment]);

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
      const result = await request<{ session: unknown }>(
        `/api/codex-sessions/${encodeURIComponent(id)}`,
        body,
      );
      const updated = parseCodexSession(result.session);
      if (updated)
        setSnapshot((current) =>
          current?.session.id === id
            ? { ...current, session: updated }
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
    ? `${webBaseUrl}/projects/${encodeURIComponent(projectId)}/settings#agent-setup`
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
    requestEnvironment(null);
    setTargetChoice("");
    blockAutoProject.current = true;
    desiredSession.current = null;
    setActionError(null);
    setProjectId(id);
    setSessionId("");
    setSnapshot(null);
    onSelectConversation?.();
  }
  function chooseTarget(key: string) {
    if (!key) return;
    desiredSession.current = null;
    requestEnvironment(null);
    setActionError(null);
    setTargetChoice(key);
    const existing = sessionForTarget(sessions, key);
    if (existing) {
      chooseAgent(existing.id);
      return;
    }
    setSessionId("");
    setSnapshot(null);
    onSelectConversation?.();
    setTargetNotice("Sign in with ChatGPT to use Codex on this environment.");
  }
  function chooseAgent(id: string) {
    requestEnvironment(null);
    desiredSession.current = null;
    setSessionId(id);
    setActionError(null);
    onSelectConversation?.();
  }
  const selectedSession = session ?? sessions.find((s) => s.id === sessionId);
  const currentTarget = pendingEnvironment
    ? `runBox:${pendingEnvironment}`
    : selectedSession
      ? targetKey(selectedSession.target)
      : targetChoice;
  const selectedBox = runBoxes.find(job => `runBox:${job.id}` === currentTarget);
  const selectedBoxUnavailable = selectedBox && !canTargetCodex(selectedBox);
  const codexTargets = deriveChatTargets(
    projectId,
    runBoxes,
    selectedSession?.target ?? (selectedBox ? {
      kind: "runBox", runBoxId: selectedBox.id, provider: selectedBox.provider ?? null,
      profileId: selectedBox.profileId ?? null, state: selectedBox.state,
    } : null),
  ).map((target) => {
    const match = sessionForTarget(sessions, target.key);
    const unavailable = !target.available;
    return {
      value: target.key,
      label: target.label,
      status: unavailable
        ? "Unavailable"
        : match
          ? statusLabel[match.status]
          : "Setup on web",
      disabled: unavailable,
    };
  });
  if (pendingEnvironment && !codexTargets.some((t) => t.value === currentTarget))
    codexTargets.push({
      value: currentTarget,
      label: environmentLabel(pendingEnvironment, null, null),
      status: "Waiting",
      disabled: true,
    });
  const targetAgents = sessions.filter(
    (item) => targetKey(item.target) === currentTarget,
  );
  const environmentName = selectedSession
    ? sessionTargetLabel(selectedSession.target)
    : "Environment";
  const context = (variant: "empty" | "header" | "toolbar") => (
    <ChatProjectPicker
      variant={variant}
      projectId={projectId}
      sessionId={sessionId}
      projects={projects.map((p) => ({ value: p.id, label: p.name }))}
      agents={targetAgents.map((item) => ({
        value: item.id,
        label: agentName(item),
      }))}
      environments={codexTargets}
      environmentValue={currentTarget}
      environmentTone={environmentTone}
      disabled={busy || attaching}
      onProject={chooseProject}
      onAgent={chooseAgent}
      onEnvironment={chooseTarget}
    />
  );
  const firstUser = messages.find((event) => event.kind === "user");
  const title = hasConversation
    ? firstUser?.text.split("\n")[0] ||
      (session ? agentName(session) : "Project chat")
    : "New chat";
  const sidebar = (close: () => void) => (
    <ChatHistory
      threads={sessions.filter((item) => targetKey(item.target) === currentTarget).map((item) => ({
        id: item.id,
        title:
          titles[item.id] || item.title ||
          (item.target.kind === "runBox"
            ? `${agentName(item)} · ${sessionTargetLabel(item.target)}`
            : agentName(item)),
        updatedAt: item.updatedAt,
        status: item.status,
      }))}
      selectedId={sessionId}
      busy={busy || attaching || !currentTarget || !targetAgents.some((item) => item.status === "ready" || item.status === "running")}
      loading={loading}
      setupUrl={settingsUrl}
      onSelect={(id) => {
        chooseAgent(id);
        close();
      }}
      onCreate={() => {
        if (currentTarget.startsWith("runBox:")) void openEnvironmentSession(currentTarget.slice("runBox:".length));
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
          environmentName={environmentName}
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
                    : pendingEnvironment
                      ? "Connecting Codex on the environment…"
                      : busy && !sessionId
                        ? "Starting Codex on this environment…"
                        : !sessionId
                          ? currentTarget ? "This environment is selected. Finish its setup to start chatting." : "Choose an environment to access its chats."
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
          {targetNotice && pendingEnvironment && (
            <p className="credential-banner" role="status">
              {targetNotice}
            </p>
          )}
          {selectedBoxUnavailable && <section className="codex-sign-in" aria-labelledby="environment-unavailable-title">
            <h2 id="environment-unavailable-title">Environment unavailable</h2>
            <p>{codexBlockedReason(selectedBox) ?? "This environment is not ready for Codex yet."}</p>
            <a className="button primary" href={`${webBaseUrl.replace(/\/$/, "")}/projects/${projectId}/environments?environment=${selectedBox.id}`} target="_blank" rel="noreferrer">View environment</a>
          </section>}
          {!selectedBoxUnavailable && selectedBox && (session?.status === "auth_required" || setupRequired[currentTarget] || (currentTarget && !selectedSession)) && (
            <section className="codex-sign-in" aria-labelledby="environment-setup-title">
              <h2 id="environment-setup-title">Sign in with ChatGPT</h2>
              <p>Codex in this environment uses your ChatGPT account. Sign-in opens in your browser, and this app connects it to the environment.</p>
              <div className="codex-sign-in-actions">
                <button className="button primary" type="button" disabled={busy || session?.status === "initializing"} onClick={() => void signInWithChatGpt()}>
                  {busy ? "Connecting…" : "Sign in with ChatGPT"}
                </button>
              </div>
            </section>
          )}
          {!sessions.length && !loading && !pendingEnvironment && (
            <a
              className="button primary"
              href={settingsUrl}
              target="_blank"
              rel="noreferrer"
            >
              Project settings
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
                : currentTarget ? "Sign in with ChatGPT to start chatting" : "Choose an environment to start chatting"
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
