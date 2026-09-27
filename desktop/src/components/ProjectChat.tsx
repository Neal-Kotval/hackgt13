import { useEffect, useRef, useState, type ReactNode } from "react";
import { desktopApi } from "../lib/desktop-api";
import type { DeepLinkParseResult, ProjectSnapshot } from "../lib/types";
import { Composer } from "./Composer";
import { CodexConversation, type CodexEvent } from "./CodexConversation";
import "./ProjectChat.css";
import { Select } from "./ui/Select";

type Session = { id: string; projectId: string; agentId: string; status: "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped"; error: string | null };
type Event = CodexEvent;
class CodexRequestError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await desktopApi().fetchHuman(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = JSON.parse(response.body);
  if (!response.ok) throw new CodexRequestError(result.error || `Request failed (${response.status})`, result.code);
  return result as T;
}

export function ProjectChat({ webBaseUrl, deepLink, onDeepLinkHandled, children }: { webBaseUrl: string; deepLink: DeepLinkParseResult | null; onDeepLinkHandled: () => void; children: (chat: {content: ReactNode; sidebar: (close: () => void) => ReactNode; busy: boolean}) => ReactNode }) {
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<{ session: Session; events: Event[] } | null>(null);
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
  const pending = useRef<Record<string, { text: string; requestId: string }>>({});
  useEffect(() => {
    let cancelled = false;
    desktopApi().getState().then(state => {
      if (cancelled) return;
      setProjects(state.projects);
      if (deepLink?.ok) {
        if (!state.projects.some(p => p.id === deepLink.target.projectId)) {
          blockAutoProject.current = true;
          desiredSession.current = deepLink.target.codexSessionId || null;
          setProjectId(""); setSessionId(""); setSnapshot(null); setSessions([]);
          setActionError("The linked project is not available to your account. Choose a project explicitly to continue.");
          setLoading(false); onDeepLinkHandled(); return;
        }
        blockAutoProject.current = false;
        desiredSession.current = deepLink.target.codexSessionId || null;
        setProjectId(deepLink.target.projectId);
        setLinkRevision(value => value + 1);
      } else if (!blockAutoProject.current) setProjectId(current => current || state.projects[0]?.id || "");
      setError(null); setLoading(false); onDeepLinkHandled();
    }).catch(err => { if (!cancelled) { setLoading(false); setError(err.message); onDeepLinkHandled(); } });
    return () => { cancelled = true; };
  }, [deepLink, onDeepLinkHandled, retry]);
  useEffect(() => {
    if (lastProject.current !== projectId || desiredSession.current) {
      setSessions([]); setSessionId(""); setSnapshot(null);
      lastProject.current = projectId;
    }
    if (!projectId) { setLoading(false); return; }
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    setLoading(true); setActionError(null);
    const poll = async () => {
      try {
        const data = await request<{ enabled: boolean; sessions: Session[] }>(`/api/codex-sessions?projectId=${encodeURIComponent(projectId)}`);
        if (cancelled) return;
        setSessions(data.sessions); setEnabled(data.enabled); setError(null);
        const requested = desiredSession.current;
        if (requested) {
          if (data.sessions.some(s => s.id === requested)) { desiredSession.current = null; setSessionId(requested); setActionError(null); }
          else setActionError("The linked Codex session is not available in this project.");
        } else setSessionId(current => data.sessions.some(s => s.id === current) ? current : data.sessions[0]?.id || "");
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "Could not load Codex sessions."); }
      finally { if (!cancelled) { setLoading(false); timer = setTimeout(poll, 1000); } }
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [projectId, retry, linkRevision]);
  useEffect(() => {
    setSnapshot(null);
    if (!sessionId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const data = await request<{ session: Session; events: Event[] }>(`/api/codex-sessions/${encodeURIComponent(sessionId)}`);
        if (!cancelled && data.session.projectId === projectId) { setSnapshot(data); setError(null); }
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : "Could not refresh session."); }
      finally { if (!cancelled) timer = setTimeout(poll, 1000); }
    };
    void poll(); return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, projectId, retry]);
  const session = snapshot?.session;
  const draft = drafts[sessionId] || "";
  async function act(action: "message" | "interrupt" | "resume", asNewTurn = false) {
    if (busy || !sessionId || (action === "message" && ambiguous[sessionId] && !asNewTurn)) return;
    const id = sessionId, text = draft.trim();
    setBusy(true); setActionError(null);
    try {
      let body: object = { action };
      if (action === "message") {
        const prior = pending.current[id];
        const turn = !asNewTurn && prior?.text === text ? prior : { text, requestId: crypto.randomUUID() };
        pending.current[id] = turn; body = { action, ...turn };
      }
      const result = await request<{ session: Session }>(`/api/codex-sessions/${encodeURIComponent(id)}`, body);
      setSnapshot(current => current?.session.id === id ? { ...current, session: result.session } : current);
      if (action === "message") { setAmbiguous(current => ({ ...current, [id]: false })); delete pending.current[id]; setDrafts(current => ({ ...current, [id]: current[id]?.trim() === text ? "" : current[id] })); }
    } catch (err) {
      if (err instanceof CodexRequestError && err.code === "ambiguous_turn") setAmbiguous(current => ({ ...current, [id]: true }));
      setActionError(err instanceof Error ? err.message : "Could not update Codex session.");
    }
    finally { setBusy(false); }
  }
  const project = projects.find(p => p.id === projectId);
  const agentName = (item: Session) => project?.agents.find(a => a.id === item.agentId)?.name || "Codex";
  const statusLabel = {initializing:"Starting",auth_required:"Sign-in required",ready:"Ready",running:"Working",error:"Needs attention",stopped:"Stopped"};
  const settingsUrl = projectId ? `${webBaseUrl}/projects/${encodeURIComponent(projectId)}/settings` : webBaseUrl;
  const messages = snapshot?.events ?? [];
  const hasConversation = messages.some(event => event.kind === "user" || event.kind === "assistant");
  const sidebar = (close: () => void) => <aside className="sidebar project-chat-sidebar" aria-label="Project conversations">
    <div className="sidebar-header"><h2 className="brand">Project</h2></div>
    <Select aria-label="Project" value={projectId} disabled={!projects.length || busy} onChange={e => { blockAutoProject.current = true; desiredSession.current = null; setActionError(null); setProjectId(e.target.value); }}><option value="">Choose project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
    <h3 className="field-label">Conversations</h3>
    <div className="thread-list" role="list">{sessions.map(item => <div className="thread-row" role="listitem" key={item.id}><button className="thread-item agent-conversation" data-selected={item.id === sessionId} aria-current={item.id === sessionId ? "true" : undefined} disabled={busy} onClick={() => {desiredSession.current=null;setSessionId(item.id);setActionError(null);close();}}><span className="thread-title">{agentName(item)}</span><span className="agent-conversation-state">{statusLabel[item.status]}</span></button></div>)}</div>
    {!sessions.length && <p className="sidebar-empty">{loading ? "Loading conversations…" : "No agent connected yet"}</p>}
    <a className="button ghost" href={settingsUrl} target="_blank" rel="noreferrer">Set up agent</a>
  </aside>;
  const content = <div className="app-shell"><main className="main" data-empty={!hasConversation}>
    <header className="main-header"><h1>Project chat</h1><div className="project-chat-status">
      {session && <span className="chat-storage-note" role="status">{agentName(session)} · {statusLabel[session.status]} · Local Docker</span>}
      {session && ["error","stopped"].includes(session.status) && <button className="button ghost" disabled={busy} onClick={() => void act("resume")}>Reconnect</button>}
    </div></header>
    <CodexConversation key={sessionId || "empty"} events={messages} working={session?.status === "running"} emptyLabel={loading ? "Loading your conversation…" : session ? "Talk to your project’s Codex agent." : enabled ? "Connect a Codex agent in project Settings to begin." : "Local Codex is not enabled on this server."} />
    <div className="chat-compose-area">
      {error && <p className="error-banner" role="alert">{error} <button className="button ghost" onClick={() => setRetry(n => n + 1)}>Retry connection</button></p>}
      {session?.error && <p className="error-banner" role="alert">{session.error}</p>}
      {session?.status === "auth_required" && <p className="credential-banner">Finish signing in to Codex in <a href={settingsUrl} target="_blank" rel="noreferrer">project Settings</a>.</p>}
      {!session && !loading && <a className="button primary" href={settingsUrl} target="_blank" rel="noreferrer">Set up agent on website</a>}
      {ambiguous[sessionId] && <div className="project-chat-recovery" role="status"><p>The previous send could not be confirmed. Check the conversation after reconnecting before sending it again.</p><button className="button warning" disabled={busy || session?.status !== "ready" || !draft.trim()} onClick={() => void act("message", true)}>Send as a new turn</button></div>}
      <Composer value={draft} disabled={!session || busy} sendDisabled={session?.status !== "ready" || Boolean(ambiguous[sessionId])} sending={session?.status === "running"} error={actionError} onChange={value=>setDrafts(current=>({...current,[sessionId]:value}))} onSend={()=>void act("message")} onStop={()=>void act("interrupt")} />
    </div>
  </main></div>;
  return children({content,sidebar,busy:busy || session?.status === "running"});
}
