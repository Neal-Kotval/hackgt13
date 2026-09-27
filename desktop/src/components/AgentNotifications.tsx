import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api";
import { mergeNotifications, notificationBytes, notificationRequestMatches, notificationStatus, NOTIFICATION_MAX_BYTES, type AgentNotification, type NotificationRequest } from "../lib/agent-notifications";
import { Select } from "./ui/Select";
import "./AgentNotifications.css";

type Peer = { id: string; title: string; agentName: string; createdByName?: string | null; status: string };
type Props = { sessionId: string; peers: Peer[]; enabled: boolean };
type History = { messages: AgentNotification[]; nextBeforeSequence: number | null };
type Draft = { text: string; recipient: string; pending: NotificationRequest | null };
// Navigation preserves unsent text and ambiguous request IDs separately for each conversation.
const drafts = new Map<string, Draft>();
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await desktopApi().fetchHuman(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = JSON.parse(response.body);
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}
export function AgentNotifications(props: Props) {
  return <SessionNotifications key={props.sessionId} {...props} />;
}
function SessionNotifications({ sessionId, peers, enabled }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(sessionId) ?? { text: "", recipient: "all", pending: null });
  const [messages, setMessages] = useState<AgentNotification[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sendNotice, setSendNotice] = useState("");
  const [sending, setSending] = useState(false);
  const [paging, setPaging] = useState(false);
  const alive = useRef(true);
  const sendingRef = useRef(false);
  const pagingRef = useRef(false);
  const initializedCursor = useRef(false);
  const id = useId();
  const path = `/api/codex-sessions/${encodeURIComponent(sessionId)}/peer-messages`;
  const recipients = peers.filter(peer => peer.id !== sessionId);
  function updateDraft(next: Draft) { drafts.set(sessionId, next); setDraft(next); }
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await request<History>(`${path}?view=history&limit=50`);
        if (cancelled) return;
        setMessages(current => mergeNotifications(current, result.messages));
        if (!initializedCursor.current) { setCursor(result.nextBeforeSequence); initializedCursor.current = true; }
        setLoaded(true);
        setHistoryError("");
      } catch (error) {
        if (!cancelled) setHistoryError(error instanceof Error ? error.message : "Could not load notifications.");
      } finally {
        if (!cancelled) timer = setTimeout(poll, 5000);
      }
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, path]);
  async function older() {
    if (cursor === null || pagingRef.current) return;
    pagingRef.current = true;
    setPaging(true);
    try {
      const result = await request<History>(`${path}?view=history&limit=50&beforeSequence=${cursor}`);
      if (!alive.current) return;
      setMessages(current => mergeNotifications(current, result.messages));
      setCursor(result.nextBeforeSequence);
      setHistoryError("");
    } catch (error) {
      if (alive.current) setHistoryError(error instanceof Error ? error.message : "Could not load older notifications.");
    } finally { pagingRef.current = false; if (alive.current) setPaging(false); }
  }
  async function send() {
    if (sendingRef.current || !enabled || !draft.text.trim() || notificationBytes(draft.text.trim()) > NOTIFICATION_MAX_BYTES) return;
    if (draft.pending && !notificationRequestMatches(draft.pending, draft.text, draft.recipient)) {
      setSendError("Retry the original message or explicitly start a new message."); return;
    }
    const pending = draft.pending ?? { requestId: crypto.randomUUID(), text: draft.text.trim(), recipient: draft.recipient };
    if (!draft.pending && (!recipients.length || (pending.recipient !== "all" && !recipients.some(peer => peer.id === pending.recipient)))) return;
    updateDraft({ ...draft, pending });
    sendingRef.current = true;
    setSending(true); setSendError(""); setSendNotice("");
    try {
      const result = await request<{ message?: AgentNotification; messages?: AgentNotification[] }>(path, {
        text: pending.text, requestId: pending.requestId,
        ...(pending.recipient === "all" ? { broadcast: true, audience: "conversations" } : { toSessionId: pending.recipient }),
      });
      const next = { text: "", recipient: pending.recipient, pending: null };
      drafts.set(sessionId, next);
      if (!alive.current) return;
      setDraft(next);
      const sent = result.messages ?? (result.message ? [result.message] : []);
      setSendNotice(sent.length ? `Notification recorded for ${sent.length} conversation${sent.length === 1 ? "" : "s"}.` : "No eligible conversations received this notification.");
      setMessages(current => mergeNotifications(current, result.messages ?? (result.message ? [result.message] : [])));
    } catch (error) {
      if (alive.current) setSendError(`${error instanceof Error ? error.message : "Send failed."} Delivery may be uncertain. Retry uses the same request ID.`);
    } finally { sendingRef.current = false; if (alive.current) setSending(false); }
  }
  const bytes = notificationBytes(draft.text.trim());
  const validRecipient = draft.recipient === "all" ? recipients.length > 0 : recipients.some(peer => peer.id === draft.recipient);
  function counterpart(message: AgentNotification) {
    const peerId = message.direction === "incoming" ? message.fromSessionId : message.toSessionId;
    const peer = peers.find(candidate => candidate.id === peerId);
    return peer ? `${peer.createdByName || "Unknown user"} · ${peer.title || peer.agentName}` : `Conversation ${peerId}`;
  }
  return <section className="agent-notifications" aria-label="Agent notifications">
    <button className="agent-notifications-toggle" type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(value => !value)}>
      <span>Agent notifications</span><span>{open ? "Hide" : "Open"}</span>
    </button>
    {open && <div className="agent-notifications-body" id={`${id}-panel`}>
      <p className="agent-notifications-hint">Notify another conversation in this environment. Acceptance means the agent received the request; follow its chat for execution results.</p>
      <form className="agent-notifications-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
        <label htmlFor={`${id}-recipient`}>Recipient</label>
        <Select id={`${id}-recipient`} value={draft.recipient} disabled={sending || Boolean(draft.pending)} onChange={event => updateDraft({ ...draft, recipient: event.target.value })}>
          <option value="all">All other conversations ({recipients.length})</option>
          {recipients.map(peer => <option key={peer.id} value={peer.id}>{peer.createdByName || "Unknown user"} · {peer.title || peer.agentName} · {peer.status}</option>)}
          {draft.recipient !== "all" && !validRecipient && <option value={draft.recipient}>Previously selected conversation</option>}
        </Select>
        <label htmlFor={`${id}-text`}>Notification message</label>
        <textarea id={`${id}-text`} rows={3} value={draft.text} disabled={sending || Boolean(draft.pending)} aria-describedby={`${id}-limit`} onChange={event => updateDraft({ ...draft, text: event.target.value })} placeholder="Share a finding, request a review, or coordinate the next step…" />
        <div className="agent-notifications-actions">
          <span id={`${id}-limit`}>{bytes.toLocaleString()} / {NOTIFICATION_MAX_BYTES.toLocaleString()} bytes</span>
          <button className="button primary" type="submit" disabled={sending || !enabled || !draft.text.trim() || bytes > NOTIFICATION_MAX_BYTES || (!draft.pending && !validRecipient)}>{sending ? "Sending…" : draft.pending ? "Retry notification" : "Send notification"}</button>
          {draft.pending && !sending && <button className="button" type="button" onClick={() => { updateDraft({ ...draft, pending: null }); setSendError(""); }}>Start a new request</button>}
        </div>
        {draft.pending && !sending && <p className="agent-notifications-hint">The previous request may already be queued. Retrying is safe; starting a new request can send another copy.</p>}
        {!enabled && <p className="agent-notifications-hint">Notifications can be sent when this environment is ready.</p>}
        {!recipients.length && <p className="agent-notifications-hint">Create another conversation in this environment to notify it.</p>}
        {bytes > NOTIFICATION_MAX_BYTES && <p role="alert" className="agent-notifications-error">Shorten this notification to 16 KB or less.</p>}
        {sendNotice && <p role="status" className="agent-notifications-hint">{sendNotice}</p>}
        {sendError && <p role="alert" className="agent-notifications-error">{sendError}</p>}
      </form>
      {historyError && <p role="alert" className="agent-notifications-error">Notification history: {historyError}</p>}
      {!loaded && !historyError && <p role="status">Retrieving notification history…</p>}
      {loaded && !messages.length && <p className="agent-notifications-hint">No notifications yet.</p>}
      <ol className="agent-notifications-history" aria-label="Notification history">
        {messages.map(message => <li key={message.id}>
          <div className="agent-notifications-meta"><strong>{message.direction === "incoming" ? "From" : "To"} {counterpart(message)}</strong><span>{notificationStatus(message.status)}</span></div>
          <p className="agent-notifications-text">{message.text}</p>
          <div className="agent-notifications-meta"><span>Sent by {message.actorName || message.actorId || "Agent"}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time></div>
        </li>)}
      </ol>
      {cursor !== null && <button className="button" type="button" disabled={paging} onClick={() => void older()}>{paging ? "Retrieving older notifications…" : "Load older notifications"}</button>}
    </div>}
  </section>;
}
