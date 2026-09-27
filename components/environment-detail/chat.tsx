"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowClockwise, ChatCircleText, Desktop, PaperPlaneRight, Plus, Robot, Stop } from "@phosphor-icons/react";
import { SkeletonRegion, SkeletonRows } from "@/components/ui/skeleton";
import { ChatMarkdown } from "./chat-markdown-view";
import {
  authorLabel, composerState, desktopConversationUrl, environmentConversations, groupTurns, parseChatEvents,
  parseChatSession, settingsSignInHref, setupSession, shouldSendOnKey, TURN_STATUS_LABEL,
  type ChatEvent, type ChatJob, type ChatSession,
} from "./chat-model";
import "./chat.css";

class ChatRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ChatRequestError(typeof data.error === "string" ? data.error : "Could not reach Codex chat.", response.status, data.code);
  return data as T;
}

const SESSION_LABEL: Record<string, string> = {
  initializing: "Connecting", auth_required: "Sign-in needed", ready: "Ready", running: "Responding", error: "Disconnected", stopped: "Closed",
};

function readableTime(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Web Codex chat for one environment. Renders only server state from /api/codex-sessions. */
export function EnvironmentChat({ projectId, job }: { projectId: string; job: ChatJob }) {
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [listError, setListError] = useState("");
  const [forbidden, setForbidden] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [snapshot, setSnapshot] = useState<{ session: ChatSession; events: ChatEvent[] } | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const newChatRequest = useRef<string | null>(null);
  const pendingTurn = useRef<{ text: string; requestId: string } | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);
  const ids = useId();

  useEffect(() => {
    setOrigin(window.location.origin);
    const requested = new URL(window.location.href).searchParams.get("chat");
    if (requested) setSelectedId(requested);
    let active = true;
    void request<{ id?: string }>("/api/employee").then(employee => { if (active && typeof employee.id === "string") setViewerId(employee.id); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Conversation list: poll the project's sessions and keep this environment's.
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<{ sessions: unknown[] }>(`/api/codex-sessions?projectId=${encodeURIComponent(projectId)}`);
        if (!active) return;
        const parsed = (Array.isArray(data.sessions) ? data.sessions : []).map(parseChatSession).filter((item): item is ChatSession => item !== null);
        setSessions(parsed);
        setListError("");
        setForbidden(false);
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ChatRequestError && (cause.status === 403 || cause.status === 404)) setForbidden(true);
        setListError(cause instanceof Error ? cause.message : "Could not load conversations.");
      } finally {
        if (active) timer = setTimeout(poll, 3000);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [projectId]);

  const conversations = useMemo(() => environmentConversations(sessions ?? [], job.id), [sessions, job.id]);
  const setup = useMemo(() => setupSession(sessions ?? [], job.id), [sessions, job.id]);

  // Keep a valid selection: the requested chat, else the newest one.
  useEffect(() => {
    if (!sessions) return;
    if (selectedId && conversations.some(item => item.id === selectedId)) return;
    const next = conversations[0]?.id ?? "";
    if (next !== selectedId) setSelectedId(next);
  }, [sessions, conversations, selectedId]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if ((url.searchParams.get("chat") ?? "") === selectedId) return;
    if (selectedId) url.searchParams.set("chat", selectedId); else url.searchParams.delete("chat");
    window.history.replaceState(window.history.state, "", url);
  }, [selectedId]);

  // Selected conversation: poll its snapshot; faster while a turn runs.
  const running = snapshot?.session.id === selectedId && snapshot.session.status === "running";
  useEffect(() => {
    if (!selectedId) { setSnapshot(null); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<{ session: unknown; events: unknown }>(`/api/codex-sessions/${encodeURIComponent(selectedId)}`);
        const session = parseChatSession(data.session);
        if (!active || !session || session.runBoxId !== job.id) return;
        setSnapshot({ session, events: parseChatEvents(data.events) });
        setSnapshotError("");
      } catch (cause) {
        if (active) setSnapshotError(cause instanceof Error ? cause.message : "Could not refresh this conversation.");
      } finally {
        if (active) timer = setTimeout(poll, running ? 1000 : 2500);
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [selectedId, job.id, running]);

  const current = snapshot?.session.id === selectedId ? snapshot : null;
  const session = current?.session ?? conversations.find(item => item.id === selectedId) ?? null;
  const turns = useMemo(() => current ? groupTurns(current.events, current.session.status) : [], [current]);
  const composer = composerState({ job, setup, sessionsLoaded: sessions !== null, session, forbidden });
  const canCreate = !forbidden && job.permissions?.open !== false && job.state === "ready" && !job.stop_requested_at
    && !!setup && ["ready", "running"].includes(setup.status);

  // A new chat focuses the composer once it can accept text.
  useEffect(() => {
    if (!focusComposer.current || !composer.enabled || session?.id !== selectedId) return;
    focusComposer.current = false;
    inputRef.current?.focus();
  }, [composer.enabled, session?.id, selectedId]);

  // Announce a finished reply once, not every streamed delta.
  const lastAnnounced = useRef<string>("");
  useEffect(() => {
    const last = turns[turns.length - 1];
    if (!last || !last.prompt || !last.status || last.status === "running") return;
    const key = `${last.prompt.id}:${last.status}`;
    if (!lastAnnounced.current) { lastAnnounced.current = key; return; }
    if (lastAnnounced.current === key) return;
    lastAnnounced.current = key;
    const reply = [...last.items].reverse().find(item => item.kind === "assistant")?.text ?? "";
    setAnnouncement(last.status === "completed" ? `Codex replied: ${reply.slice(0, 500)}` : `Codex turn ${TURN_STATUS_LABEL[last.status].toLowerCase()}.`);
  }, [turns]);
  useEffect(() => { lastAnnounced.current = ""; setAnnouncement(""); }, [selectedId]);

  // Stay pinned to the newest message unless the reader scrolled up.
  useEffect(() => {
    const node = logRef.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [current]);
  function trackScroll() {
    const node = logRef.current;
    if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
  }

  const newChat = useCallback(async () => {
    if (!setup) return;
    setBusy(true); setActionError("");
    newChatRequest.current ||= crypto.randomUUID();
    try {
      const result = await request<{ session: unknown }>("/api/codex-sessions", {
        projectId, agentId: setup.agentId, runBoxId: job.id, newChat: true, requestId: newChatRequest.current,
      });
      newChatRequest.current = null;
      const created = parseChatSession(result.session);
      if (created) {
        setSessions(list => [...(list ?? []).filter(item => item.id !== created.id), created]);
        following.current = true;
        setSelectedId(created.id);
        focusComposer.current = true;
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not start a new chat.");
    } finally { setBusy(false); }
  }, [projectId, job.id, setup]);

  async function act(action: "message" | "interrupt" | "resume") {
    if (!session || busy) return;
    const id = session.id;
    let body: object = { action };
    if (action === "message") {
      const text = draft.trim();
      if (!text) return;
      if (text.length > 16000) { setActionError("Keep the message within 16,000 characters."); return; }
      // Reuse the request ID for an identical retry so the server never runs it twice.
      const prior = pendingTurn.current;
      const turn = prior?.text === text ? prior : { text, requestId: crypto.randomUUID() };
      pendingTurn.current = turn;
      body = { action, ...turn };
    }
    setBusy(true); setActionError("");
    try {
      const result = await request<{ session: unknown }>(`/api/codex-sessions/${encodeURIComponent(id)}`, body);
      const updated = parseChatSession(result.session);
      if (updated) setSnapshot(value => value?.session.id === id ? { ...value, session: updated } : value);
      if (action === "message") { pendingTurn.current = null; setDraft(""); following.current = true; }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not update this conversation.");
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent) { event.preventDefault(); if (composer.enabled) void act("message"); }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendOnKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.nativeEvent.isComposing, altKey: event.altKey })) {
      event.preventDefault();
      if (composer.enabled && !busy) void act("message");
    }
  }

  const desktopUrl = session && origin ? desktopConversationUrl(projectId, session.id, origin) : "";
  const hintId = `${ids}-hint`, reasonId = `${ids}-reason`, titleId = `${ids}-title`;

  return <section className="env-chat" aria-labelledby={titleId}>
    <h2 id={titleId} className="visually-hidden">Codex chat</h2>
    <nav className="env-chat-list" aria-label="Conversations">
      <div className="env-chat-list-header">
        <h3>Conversations</h3>
        <button className="button primary" type="button" onClick={() => void newChat()} disabled={busy || !canCreate}
          aria-describedby={!canCreate && !composer.enabled ? reasonId : undefined}
          title={!canCreate && !composer.enabled ? composer.reason : undefined}>
          <Plus aria-hidden="true" />New chat
        </button>
      </div>
      {sessions === null && !listError ? <SkeletonRegion label="Loading conversations"><SkeletonRows count={3} trailing={false} /></SkeletonRegion> : null}
      {sessions !== null && conversations.length === 0 ? <p className="env-chat-empty">No conversations on this environment yet.</p> : null}
      {conversations.length > 0 ? <ul>
        {conversations.map(item => <li key={item.id}>
          <button type="button" className="env-chat-list-item" aria-current={item.id === selectedId ? "true" : undefined} onClick={() => { following.current = true; setSelectedId(item.id); }}>
            <span className="env-chat-list-title">{item.title}</span>
            <span className="env-chat-list-meta">
              <span className="env-chat-badge" data-status={item.status}>{SESSION_LABEL[item.status] ?? item.status}</span>
              <span>{readableTime(item.createdAt)}</span>
            </span>
          </button>
        </li>)}
      </ul> : null}
    </nav>

    <div className="env-chat-main">
      <header className="env-chat-header">
        <div className="env-chat-heading">
          <h3>{session ? session.title : "Codex"}</h3>
          {session ? <span className="env-chat-badge" data-status={session.status}>{SESSION_LABEL[session.status] ?? session.status}</span> : null}
        </div>
        <div className="env-chat-header-actions">
          {session?.status === "running" ? <button className="button danger" type="button" disabled={busy} onClick={() => void act("interrupt")}><Stop aria-hidden="true" />Stop</button> : null}
          {desktopUrl ? <a className="button" href={desktopUrl}><Desktop aria-hidden="true" />Open in desktop</a> : null}
        </div>
      </header>

      {listError && !forbidden ? <p className="env-chat-alert" role="alert">{listError}</p> : null}
      {snapshotError ? <p className="env-chat-alert" role="alert">{snapshotError}</p> : null}
      {actionError ? <p className="env-chat-alert" role="alert">{actionError}</p> : null}

      <div className="env-chat-log" ref={logRef} onScroll={trackScroll} role="log" aria-live="off" aria-label="Messages" tabIndex={0}>
        {!session ? <div className="env-chat-placeholder"><ChatCircleText aria-hidden="true" /><p>{conversations.length ? "Choose a conversation." : "Start a new chat to work with Codex in this environment."}</p></div> : null}
        {session && !current && !snapshotError ? <SkeletonRegion label="Loading messages"><SkeletonRows count={2} trailing={false} /></SkeletonRegion> : null}
        {current && turns.length === 0 ? <div className="env-chat-placeholder"><ChatCircleText aria-hidden="true" /><p>No messages yet. Send the first one below.</p></div> : null}
        {turns.map((turn, index) => <div className="env-chat-turn" key={turn.prompt?.id ?? `pre-${index}`}>
          {turn.prompt ? <article className="env-chat-message" data-role="user">
            <div className="env-chat-author">
              <span>{authorLabel(turn.prompt, viewerId)}</span>
              {turn.status ? <span className="env-chat-turn-status" data-status={turn.status}>{TURN_STATUS_LABEL[turn.status]}</span> : null}
            </div>
            <p className="env-chat-user-text">{turn.prompt.text}</p>
          </article> : null}
          {turn.items.map(item => item.kind === "assistant"
            ? <article className="env-chat-message" data-role="assistant" key={item.id}>
              <div className="env-chat-author"><Robot aria-hidden="true" /><span>Codex</span></div>
              {item.text ? <ChatMarkdown text={item.text} /> : null}
            </article>
            : <p className="env-chat-event" data-kind={item.kind} key={item.id} role={item.kind === "error" ? "alert" : undefined}>
              {item.kind === "error" ? "Error: " : ""}{item.text}
            </p>)}
          {turn.status === "running" && index === turns.length - 1 ? <p className="env-chat-event" data-kind="running" role="status">Codex is responding…</p> : null}
        </div>)}
      </div>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</p>

      <form className="env-chat-composer" onSubmit={submit}>
        <label htmlFor={`${ids}-input`} className="visually-hidden">Message Codex</label>
        <textarea id={`${ids}-input`} ref={inputRef} rows={3} value={draft} maxLength={16000}
          onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown}
          disabled={!composer.enabled} placeholder={composer.enabled ? "Message Codex" : undefined}
          aria-describedby={composer.enabled ? hintId : `${reasonId} ${hintId}`} />
        <div className="env-chat-composer-footer">
          <p id={hintId} className="env-chat-hint">Enter sends. Shift+Enter adds a new line.</p>
          <button className="button primary" type="submit" disabled={!composer.enabled || busy || !draft.trim()}>
            <PaperPlaneRight aria-hidden="true" />Send
          </button>
        </div>
        {!composer.enabled ? <div className="env-chat-reason" id={reasonId} role="status">
          <span>{composer.reason}</span>
          {composer.signIn ? <Link href={settingsSignInHref(projectId, job.id)}>Open Codex sign-in in Settings</Link> : null}
          {composer.reconnect ? <button className="button" type="button" disabled={busy} onClick={() => void act("resume")}><ArrowClockwise aria-hidden="true" />Reconnect</button> : null}
        </div> : null}
      </form>
    </div>
  </section>;
}
