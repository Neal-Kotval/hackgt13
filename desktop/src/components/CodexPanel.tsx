import { useEffect, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api";
import type { DeepLinkParseResult, ProjectSnapshot } from "../lib/types";
import { Select } from "./ui/Select";

type Session = { id: string; projectId: string; agentId: string; status: "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped"; error: string | null };
type Event = { id: string; kind: "user" | "assistant" | "command" | "status" | "error"; text: string; actorName?: string; updatedAt: string };
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await desktopApi().fetchHuman(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const result = JSON.parse(response.body);
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}

export function CodexPanel({ webBaseUrl, deepLink, onDeepLinkHandled }: { webBaseUrl: string; deepLink: DeepLinkParseResult | null; onDeepLinkHandled: () => void }) {
  const [projects, setProjects] = useState<ProjectSnapshot[]>([]);
  const [projectId, setProjectId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<{ session: Session; events: Event[] } | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  const [linkRevision, setLinkRevision] = useState(0);
  const desiredSession = useRef<string | null>(null);
  // Preserve request identity on ambiguous network failures; backend deduplicates retries.
  const pending = useRef<Record<string, { text: string; requestId: string }>>({});
  useEffect(() => {
    let cancelled = false;
    desktopApi().getState().then(state => {
      if (cancelled) return;
      setProjects(state.projects);
      if (deepLink?.ok) {
        if (!state.projects.some(p => p.id === deepLink.target.projectId)) throw new Error("This project is not available to your account.");
        desiredSession.current = deepLink.target.codexSessionId || null;
        setProjectId(deepLink.target.projectId);
        setLinkRevision(value => value + 1);
      } else setProjectId(current => current || state.projects[0]?.id || "");
      setError(null); setLoading(false); onDeepLinkHandled();
    }).catch(err => { if (!cancelled) { setLoading(false); setError(err.message); onDeepLinkHandled(); } });
    return () => { cancelled = true; };
  }, [deepLink, onDeepLinkHandled, retry]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    setSessions([]); setSessionId(""); setSnapshot(null); setLoading(true); setActionError(null);
    const poll = async () => {
      try {
        const data = await request<{ enabled: boolean; sessions: Session[] }>(`/api/codex-sessions?projectId=${encodeURIComponent(projectId)}`);
        if (cancelled) return;
        setSessions(data.sessions); setEnabled(data.enabled); setError(null);
        const requested = desiredSession.current;
        if (requested) {
          desiredSession.current = null;
          if (data.sessions.some(s => s.id === requested)) setSessionId(requested);
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
  async function act(action: "message" | "interrupt" | "resume") {
    if (busy || !sessionId) return;
    const id = sessionId, text = draft.trim();
    setBusy(true); setActionError(null);
    try {
      let body: object = { action };
      if (action === "message") {
        const prior = pending.current[id];
        const turn = prior?.text === text ? prior : { text, requestId: crypto.randomUUID() };
        pending.current[id] = turn; body = { action, ...turn };
      }
      const result = await request<{ session: Session }>(`/api/codex-sessions/${encodeURIComponent(id)}`, body);
      setSnapshot(current => current?.session.id === id ? { ...current, session: result.session } : current);
      if (action === "message") { delete pending.current[id]; setDrafts(current => ({ ...current, [id]: current[id]?.trim() === text ? "" : current[id] })); }
    } catch (err) { setActionError(err instanceof Error ? err.message : "Could not update Codex session."); }
    finally { setBusy(false); }
  }
  return <main className="tasks-panel codex-panel">
    <header className="tasks-panel-header"><div><h1>Codex agents</h1><p className="brand-meta">Talk to the Codex process in your local Docker box. Project chat remains a separate local scratchpad.</p></div></header>
    <div className="codex-selectors">
      <Select aria-label="Project" value={projectId} disabled={!projects.length || busy} onChange={e => { desiredSession.current = null; setProjectId(e.target.value); }}><option value="">Choose project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      <Select aria-label="Codex session" value={sessionId} disabled={!sessions.length || busy} onChange={e => { setSessionId(e.target.value); setActionError(null); }}><option value="">Choose Codex agent</option>{sessions.map(s => <option key={s.id} value={s.id}>{projects.find(p => p.id === projectId)?.agents.find(a => a.id === s.agentId)?.name || s.agentId} · {s.status.replaceAll("_", " ")}</option>)}</Select>
    </div>
    {error && <p className="error-banner" role="alert">{error} <button className="button ghost" onClick={() => setRetry(n => n + 1)}>Retry connection</button></p>}
    {loading ? <p role="status">Loading Codex sessions…</p> : !sessionId && <div className="project-detail"><h2>{enabled ? "Initialize an agent on the website" : "Local Codex is not enabled"}</h2><p>Set up a Codex agent for this project on the website, then return here to send instructions.</p><a className="button primary" href={webBaseUrl} target="_blank" rel="noreferrer">Open AgentCloud website</a></div>}
    {session && <>
      <div className="codex-session-status"><span className="field-label">Local Docker · {session.status.replaceAll("_", " ")}</span>{session.status === "running" && <button className="button danger" disabled={busy} onClick={() => void act("interrupt")}>Stop generation</button>}{["error", "stopped"].includes(session.status) && <button className="button primary" disabled={busy} onClick={() => void act("resume")}>Reconnect Codex</button>}</div>
      {session.error && <p className="error-banner" role="alert">{session.error}</p>}
      {session.status === "auth_required" && <p className="credential-banner">Codex authentication is required. Complete the setup instructions on the website before sending a message.</p>}
      <div className="codex-events" aria-label="Codex conversation">{snapshot.events.length ? snapshot.events.map(event => <article className="codex-event" data-kind={event.kind} key={event.id}><strong className="field-label">{event.kind === "command" ? "Command · Local Docker" : event.kind === "assistant" ? "Codex" : event.kind === "user" ? event.actorName || "Project member" : event.kind}</strong><pre>{event.text}</pre></article>) : <p className="brand-meta">No messages yet. Send instructions when Codex is ready.</p>}</div>
      <form className="composer" onSubmit={e => { e.preventDefault(); if (session.status === "ready" && draft.trim() && !busy) void act("message"); }}><label className="composer-hint" htmlFor="codex-message">Message Codex · instructions run inside the local Docker box</label><div className="composer-row"><textarea id="codex-message" value={draft} placeholder="Ask Codex to work on your project" onChange={e => setDrafts(current => ({ ...current, [sessionId]: e.target.value }))} /><button className="button primary" disabled={busy || session.status !== "ready" || !draft.trim()}>Send to Codex</button></div></form>
    </>}
    {actionError && <p className="error-banner" role="alert">{actionError}</p>}
  </main>;
}
