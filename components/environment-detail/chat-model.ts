/** Structured, server-redacted evidence; never inferred from assistant prose. */
export type CodexEventDetails = {
  type: "commandExecution" | "fileChange";
  status: string;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  durationMs?: number | null;
  output?: string;
  changes?: { path: string; kind: string; diff: string; movePath?: string }[];
  truncated?: boolean;
};

export function parseCodexEventDetails(value: unknown): CodexEventDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if ((record.type !== "commandExecution" && record.type !== "fileChange") || typeof record.status !== "string") return undefined;
  const result: CodexEventDetails = { type: record.type, status: record.status };
  for (const key of ["command", "cwd", "output"] as const) if (typeof record[key] === "string") result[key] = record[key];
  for (const key of ["exitCode", "durationMs"] as const) if (record[key] === null || (typeof record[key] === "number" && Number.isFinite(record[key]))) result[key] = record[key] as number | null;
  if (typeof record.truncated === "boolean") result.truncated = record.truncated;
  if (Array.isArray(record.changes)) result.changes = record.changes.flatMap(value => {
    if (!value || typeof value !== "object") return [];
    const change = value as Record<string, unknown>;
    if (typeof change.path !== "string" || typeof change.kind !== "string" || typeof change.diff !== "string") return [];
    return [{ path: change.path, kind: change.kind, diff: change.diff, ...(typeof change.movePath === "string" ? { movePath: change.movePath } : {}) }];
  });
  return result;
}

/**
 * Pure mapping for the web environment Codex chat. Everything here reads the
 * server's `/api/codex-sessions` responses; nothing synthesizes messages.
 */

export type ChatSessionStatus = "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped";

export type ChatSession = {
  id: string;
  title: string;
  isSetupSession: boolean;
  projectId: string;
  agentId: string;
  runBoxId: string | null;
  status: ChatSessionStatus | string;
  activeTurnId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ChatEvent = {
  details?: CodexEventDetails;
  id: string;
  kind: "user" | "assistant" | "command" | "status" | "error";
  text: string;
  createdAt: string;
  updatedAt: string;
  actorId: string | null;
  actorName: string | null;
};

export type TurnStatus = "running" | "completed" | "failed" | "interrupted" | "unknown";

export type ChatTurn = {
  /** The user event that started the turn, or null for events before any user message. */
  prompt: ChatEvent | null;
  /** Assistant replies, command summaries, and errors that followed the prompt. */
  items: ChatEvent[];
  status: TurnStatus | null;
};

export type ChatJob = {
  id: string;
  state: string;
  stop_requested_at?: string | null;
  permissions?: { open: boolean; stop?: boolean; manage?: boolean };
  agent?: { codex?: { state?: string | null } | null } | null;
};

const text = (value: unknown) => (typeof value === "string" ? value : "");
const nullable = (value: unknown) => (typeof value === "string" ? value : null);

export function parseChatSession(value: unknown): ChatSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.projectId !== "string") return null;
  const target = record.target && typeof record.target === "object" ? (record.target as Record<string, unknown>) : {};
  const isSetupSession = record.isSetupSession !== false;
  // The server titles every untitled session "New chat"; the environment's setup
  // session is its first (main) chat, so name it apart from new independent chats.
  const rawTitle = text(record.title);
  return {
    id: record.id,
    title: isSetupSession && (!rawTitle || rawTitle === "New chat") ? "Main chat" : rawTitle || "New chat",
    isSetupSession,
    projectId: record.projectId,
    agentId: text(record.agentId),
    runBoxId: target.kind === "runBox" && typeof target.runBoxId === "string" ? target.runBoxId : null,
    status: text(record.status),
    activeTurnId: nullable(record.activeTurnId),
    error: nullable(record.error),
    createdAt: text(record.createdAt),
    updatedAt: text(record.updatedAt),
  };
}

const EVENT_KINDS = new Set(["user", "assistant", "command", "status", "error"]);

export function parseChatEvents(value: unknown): ChatEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !EVENT_KINDS.has(String(record.kind))) return [];
    const details = parseCodexEventDetails(record.details);
    return [{
      id: record.id,
      kind: record.kind as ChatEvent["kind"],
      text: text(record.text),
      ...(details ? { details } : {}),
      createdAt: text(record.createdAt),
      updatedAt: text(record.updatedAt),
      actorId: nullable(record.actorId),
      actorName: nullable(record.actorName),
    }];
  });
}

/** Sessions (setup and independent chats) on this environment, newest first. */
export function environmentConversations(sessions: ChatSession[], runBoxId: string): ChatSession[] {
  const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
  return sessions
    .filter((session) => session.runBoxId === runBoxId)
    .sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id.localeCompare(a.id));
}

/** The canonical session that owns the environment's Codex sign-in (earliest setup session). */
export function setupSession(sessions: ChatSession[], runBoxId: string): ChatSession | null {
  return sessions.find((session) => session.runBoxId === runBoxId && session.isSetupSession) ?? null;
}

const TURN_RESULT = /^Turn (completed|failed|interrupted|inProgress)$/;

/**
 * Group the event log into turns. A `user` event opens a turn; the server's
 * `Turn <status>` status event closes it. The last open turn is running only
 * while the session reports `running`.
 */
export function groupTurns(events: ChatEvent[], sessionStatus: string): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let current: ChatTurn | null = null;
  for (const event of events) {
    if (event.kind === "user") {
      current = { prompt: event, items: [], status: null };
      turns.push(current);
      continue;
    }
    const result = event.kind === "status" ? TURN_RESULT.exec(event.text) : null;
    if (result) {
      if (current && current.status === null) current.status = result[1] === "inProgress" ? "running" : (result[1] as TurnStatus);
      continue;
    }
    if (event.kind === "status" && !current) continue; // Setup chatter before any message.
    if (!current) { current = { prompt: null, items: [], status: null }; turns.push(current); }
    current.items.push(event);
  }
  turns.forEach((turn, index) => {
    if (turn.prompt === null || turn.status !== null) return;
    const last = index === turns.length - 1;
    turn.status = last && sessionStatus === "running" ? "running" : last && sessionStatus === "error" ? "failed" : "unknown";
  });
  return turns;
}

export const TURN_STATUS_LABEL: Record<TurnStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  unknown: "Status unavailable",
};

export function authorLabel(event: ChatEvent, viewerId: string | null): string {
  const name = event.actorName?.trim() || "Project member";
  return viewerId && event.actorId === viewerId ? `${name} (you)` : name;
}

export type ComposerState =
  | { enabled: true }
  | { enabled: false; reason: string; signIn?: boolean; reconnect?: boolean };

/**
 * Why the composer is unavailable, checked in the order a person would fix it:
 * access, environment, Codex install, sign-in, then the selected chat's session.
 */
export function composerState(input: {
  job: ChatJob;
  setup: ChatSession | null;
  sessionsLoaded: boolean;
  session: ChatSession | null;
  forbidden: boolean;
}): ComposerState {
  const { job, setup, session } = input;
  if (input.forbidden || job.permissions?.open === false)
    return { enabled: false, reason: "You don’t have permission to chat in this environment." };
  if (job.stop_requested_at || job.state === "stopping")
    return { enabled: false, reason: "This environment is stopping. Chat is unavailable." };
  if (job.state !== "ready")
    return { enabled: false, reason: job.state === "stopped" || job.state === "failed" ? `This environment is ${job.state}. Chat is unavailable.` : "Chat opens when this environment is ready." };
  const codex = job.agent?.codex?.state;
  if (codex && codex !== "ready")
    return { enabled: false, reason: codex === "pending" ? "Checking Codex on this environment." : "Codex is not available on this environment." };
  if (!input.sessionsLoaded) return { enabled: false, reason: "Checking Codex sign-in." };
  if (!setup || !["ready", "running"].includes(setup.status))
    return { enabled: false, reason: setup?.status === "initializing" ? "Codex is connecting to this environment." : "Sign in to Codex for this environment in Settings.", signIn: setup?.status !== "initializing" };
  if (!session) return { enabled: false, reason: "Start a new chat to message Codex." };
  if (session.status === "running") return { enabled: false, reason: "Codex is responding. Stop the turn to send a new message." };
  if (session.status === "initializing") return { enabled: false, reason: "Codex is connecting to this chat." };
  if (session.status === "auth_required") return { enabled: false, reason: "Sign in to Codex for this environment in Settings.", signIn: true };
  if (session.status === "error" || session.status === "stopped")
    return { enabled: false, reason: session.error || "This chat is disconnected. Reconnect to continue.", reconnect: true };
  if (session.status !== "ready") return { enabled: false, reason: "Codex is not ready for this chat." };
  return { enabled: true };
}

/** `agentcloud://` link that opens this conversation in the desktop app. */
export function desktopConversationUrl(projectId: string, sessionId: string, serverUrl?: string): string {
  return `agentcloud://open?${new URLSearchParams({ projectId, codexSessionId: sessionId, ...(serverUrl ? { serverUrl } : {}) })}`;
}

export function settingsSignInHref(projectId: string, runBoxId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/settings?${new URLSearchParams({ environment: runBoxId })}#agent-setup`;
}

/** Enter sends; Shift+Enter (and IME composition) inserts a newline. */
export function shouldSendOnKey(key: { key: string; shiftKey: boolean; isComposing?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): boolean {
  return key.key === "Enter" && !key.shiftKey && !key.isComposing && !key.altKey;
}
