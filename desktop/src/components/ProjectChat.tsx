import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../lib/desktop-api";
import { parseDeviceLogin, type DeviceLogin } from "../lib/chatgpt-sign-in";
import {
  LOCAL_TARGET_KEY,
  deriveChatTargets,
  parseCodexSession,
  parseCodexSessions,
  sessionForTarget,
  sessionTargetLabel,
  targetKey,
  type CodexSession,
} from "../lib/codex-targets";
import type { DeepLinkParseResult, ProjectSnapshot } from "../lib/types";
import { Composer, type ChatAttachment } from "./Composer";
import { CodexConversation, type CodexEvent } from "./CodexConversation";
import "./ProjectChat.css";
import { ChatProjectPicker } from "./ChatProjectPicker";
import { ChatHistory } from "./ChatHistory";
import {
  canOpenTerminal,
  canTargetCodex,
  codexBlockedReason,
  isTransitional,
  runBoxStateLabel,
  type RunBoxSummary,
} from "../lib/run-boxes";

type Session = CodexSession;
const TERMINAL_PREFIX = "terminal:";
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
  const [runBoxesFor, setRunBoxesFor] = useState("");
  const [sessionsFor, setSessionsFor] = useState("");
  // Codex target with no session yet (picker value when nothing is selected).
  const [targetChoice, setTargetChoice] = useState(LOCAL_TARGET_KEY);
  // Environment requested by a panel=codex link or Environments "Open Codex".
  const [pendingEnvironment, setPendingEnvironment] = useState<string | null>(null);
  const pendingEnvironmentRef = useRef<string | null>(null);
  const [targetNotice, setTargetNotice] = useState<string | null>(null);
  const [logins, setLogins] = useState<Record<string, DeviceLogin>>({});
  const [codeCopied, setCodeCopied] = useState(false);
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
          choosing.current = false;
          blockAutoProject.current = false;
          desiredSession.current = deepLink.target.codexSessionId || null;
          requestEnvironment(
            deepLink.target.panel === "codex" && deepLink.target.runBoxId
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
        const list = parseCodexSessions(data.sessions);
        setSessions(list);
        setSessionsFor(projectId);
        setEnabled(data.enabled);
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
        } else if (!choosing.current && !pendingEnvironmentRef.current)
          setSessionId((current) =>
            list.some((s) => s.id === current) ? current : list[0]?.id || "",
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
        if (!cancelled && parsed && parsed.projectId === projectId) {
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
  // A device code is only meaningful while the session still needs sign-in.
  useEffect(() => {
    if (!session || session.status === "auth_required") return;
    setLogins((current) => {
      if (!current[session.id]) return current;
      const next = { ...current };
      delete next[session.id];
      return next;
    });
  }, [session]);
  const login =
    session?.status === "auth_required" ? logins[session.id] : undefined;
  useEffect(() => setCodeCopied(false), [login?.userCode]);

  function codexAgentId(): string | null {
    const current = sessions.find((s) => s.id === sessionId)?.agentId;
    if (current) return current;
    if (sessions[0]?.agentId) return sessions[0].agentId;
    return (
      project?.agents.find((a) => a.client?.toLowerCase() === "codex")?.id ??
      null
    );
  }

  async function openEnvironmentSession(runBoxId: string) {
    const agentId = codexAgentId();
    if (!projectId || !agentId) {
      setActionError(
        "Register a Codex agent in project Settings before using Codex on an environment.",
      );
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const result = await request<{ session: unknown }>(
        "/api/codex-sessions",
        { projectId, agentId, runBoxId },
      );
      const created = parseCodexSession(result.session);
      // Older servers ignore runBoxId and return the local session: never present it as remote.
      if (!created || targetKey(created.target) !== `runBox:${runBoxId}`) {
        setActionError(
          "This alto server cannot run Codex on environments yet. Update the server, then try again.",
        );
        return;
      }
      choosing.current = false;
      setSessions((current) => [
        ...current.filter((s) => s.id !== created.id),
        created,
      ]);
      setSessionId(created.id);
      onSelectConversation?.();
    } catch (err) {
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
      choosing.current = false;
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
    if (canTargetCodex(job)) {
      requestEnvironment(null);
      void openEnvironmentSession(job.id);
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

  async function signIn(id: string) {
    setBusy(true);
    setActionError(null);
    try {
      const result = await request<{ session: unknown; login?: unknown }>(
        `/api/codex-sessions/${encodeURIComponent(id)}`,
        { action: "login" },
      );
      const device = parseDeviceLogin(result.login);
      if (!device)
        throw new Error(
          "The sign-in service returned an unexpected verification address.",
        );
      setLogins((current) => ({ ...current, [id]: device }));
      await openSignInPage(device.verificationUrl);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not start ChatGPT sign-in.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function openSignInPage(url: string) {
    try {
      await desktopApi().openChatGptSignIn(url);
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not open the sign-in page.",
      );
    }
  }
  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
    } catch {
      setActionError("Could not copy the code. Select it and copy it manually.");
    }
  }

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
    requestEnvironment(null);
    setTargetChoice(LOCAL_TARGET_KEY);
    blockAutoProject.current = true;
    desiredSession.current = null;
    choosing.current = false;
    setActionError(null);
    setProjectId(id);
    setSessionId("");
    setSnapshot(null);
    onSelectConversation?.();
  }
  function chooseTarget(key: string) {
    if (!key) return;
    if (key.startsWith(TERMINAL_PREFIX)) {
      onOpenTerminal?.(projectId, key.slice(TERMINAL_PREFIX.length));
      return;
    }
    desiredSession.current = null;
    requestEnvironment(null);
    setActionError(null);
    setTargetChoice(key);
    const existing = sessionForTarget(sessions, key);
    if (existing) {
      chooseAgent(existing.id);
      return;
    }
    choosing.current = true;
    setSessionId("");
    setSnapshot(null);
    onSelectConversation?.();
    if (key !== LOCAL_TARGET_KEY)
      void openEnvironmentSession(key.slice("runBox:".length));
  }
  function chooseAgent(id: string) {
    requestEnvironment(null);
    desiredSession.current = null;
    choosing.current = !id;
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
  const codexTargets = deriveChatTargets(
    projectId,
    runBoxes,
    selectedSession?.target,
  ).map((target) => {
    const match = sessionForTarget(sessions, target.key);
    const unavailable = target.kind === "runBox" && !target.available;
    return {
      value: target.key,
      label: target.label,
      status: unavailable
        ? "Unavailable"
        : match
          ? statusLabel[match.status]
          : target.kind === "local"
            ? "Not set up"
            : "New",
      disabled: unavailable,
    };
  });
  if (pendingEnvironment && !codexTargets.some((t) => t.value === currentTarget))
    codexTargets.push({
      value: currentTarget,
      label: `Environment ${pendingEnvironment.slice(0, 8)}`,
      status: "Waiting",
      disabled: true,
    });
  const terminalTargets = runBoxes.map((box) => ({
    value: `${TERMINAL_PREFIX}${box.id}`,
    label: `${sessionTargetLabel({ kind: "runBox", runBoxId: box.id, provider: box.provider, profileId: box.profileId, state: box.state })} · SSH terminal`,
    status: runBoxStateLabel(box),
    disabled: !canOpenTerminal(box),
  }));
  const targetAgents = sessions.filter(
    (item) => targetKey(item.target) === currentTarget,
  );
  const environmentName = selectedSession
    ? sessionTargetLabel(selectedSession.target)
    : "Local Codex box";
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
      environments={[...codexTargets, ...terminalTargets]}
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
                      : !sessionId && currentTarget !== LOCAL_TARGET_KEY
                        ? "Starting Codex on this environment…"
                    : !enabled && !sessions.length
                      ? "Local Codex is not enabled on this server. Choose an environment to run Codex there."
                      : !sessions.length
                        ? "Connect an agent in project Settings, or choose an environment."
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
          {targetNotice && pendingEnvironment && (
            <p className="credential-banner" role="status">
              {targetNotice}
            </p>
          )}
          {session?.status === "auth_required" && (
            <section
              className="codex-sign-in"
              aria-labelledby="codex-sign-in-title"
            >
              <h2 id="codex-sign-in-title">Sign in with ChatGPT</h2>
              <p>
                Codex on {environmentName} needs your ChatGPT account. Usage is
                billed to your ChatGPT plan. The sign-in stays on{" "}
                {session.target.kind === "runBox"
                  ? "this environment until it stops"
                  : "this local Codex box until it is removed"}
                .
              </p>
              {login ? (
                <>
                  <p>Enter this code on the OpenAI page that opened in your browser:</p>
                  <div className="codex-sign-in-code-row">
                    <code
                      className="codex-sign-in-code"
                      aria-label="One-time sign-in code"
                    >
                      {login.userCode}
                    </code>
                    <button
                      type="button"
                      className="button ghost"
                      onClick={() => void copyCode(login.userCode)}
                    >
                      {codeCopied ? "Copied" : "Copy code"}
                    </button>
                  </div>
                  <p className="codex-sign-in-wait" role="status">
                    Waiting for you to approve the sign-in. The composer unlocks
                    when it completes.
                  </p>
                  <div className="codex-sign-in-actions">
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy}
                      onClick={() => void openSignInPage(login.verificationUrl)}
                    >
                      Open sign-in page again
                    </button>
                    <button
                      type="button"
                      className="button ghost"
                      disabled={busy}
                      onClick={() => void signIn(session.id)}
                    >
                      Get a new code
                    </button>
                  </div>
                </>
              ) : (
                <div className="codex-sign-in-actions">
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy}
                    onClick={() => void signIn(session.id)}
                  >
                    {busy ? "Requesting a code…" : "Sign in with ChatGPT"}
                  </button>
                </div>
              )}
            </section>
          )}
          {!sessions.length && !loading && !pendingEnvironment && currentTarget === LOCAL_TARGET_KEY && (
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
