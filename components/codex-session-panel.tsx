"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Command, Desktop, Play, Stop } from "@phosphor-icons/react";
import type { Project } from "@/lib/types";
import { Select } from "./ui/select";
import "./codex-session-panel.css";

type SessionStatus = "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped";
type Session = {
  id: string;
  projectId: string;
  agentId: string;
  status: SessionStatus;
  error: string | null;
  target?: { kind: "local" } | { kind: "runBox"; runBoxId: string };
};
type Login = { verificationUrl: string; userCode: string };
const labels: Record<SessionStatus, string> = {
  initializing: "Starting box", auth_required: "Sign-in required", ready: "Ready",
  running: "Working", error: "Needs attention", stopped: "Stopped",
};

async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not reach the Codex session service.");
  return data as T;
}

function safeLogin(login: Login): boolean {
  try {
    const url = new URL(login.verificationUrl);
    return url.origin === "https://auth.openai.com" && !url.username && !url.password;
  } catch { return false; }
}

export function CodexSessionPanel({ project }: { project: Project }) {
  // Key the internal panel so changing project cannot retain another project's actions.
  return <ProjectCodexSessions key={project.id} project={project} />;
}

function ProjectCodexSessions({ project }: { project: Project }) {
  const agents = project.agents.filter((agent) => agent.client.toLowerCase() === "codex");
  const [selectedAgent, setSelectedAgent] = useState("");
  const agentId = agents.some((agent) => agent.id === selectedAgent) ? selectedAgent : agents[0]?.id ?? "";
  const [sessions, setSessions] = useState<Session[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [logins, setLogins] = useState<Record<string, Login>>({});
  const [retry, setRetry] = useState(0);
  const [serverUrl, setServerUrl] = useState("");

  useEffect(() => setServerUrl(window.location.origin), []);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [data, employee] = await Promise.all([
          request<{ enabled: boolean; sessions: Session[] }>(`/api/codex-sessions?projectId=${encodeURIComponent(project.id)}`),
          request<{ memberships: { projectId: string; role: string }[] }>("/api/employee"),
        ]);
        if (disposed) return;
        // This panel manages local Docker boxes; environment sessions are opened from Project chat.
        const local = data.sessions.filter((session) => !session.target || session.target.kind === "local");
        setSessions(local);
        setEnabled(data.enabled);
        setOwner(employee.memberships.some((membership) => membership.projectId === project.id && membership.role === "owner"));
        setLoadError("");
        timer = setTimeout(refresh, local.some((session) => session.status !== "stopped") ? 1000 : 5000);
      } catch (cause) {
        if (!disposed) setLoadError(cause instanceof Error ? cause.message : "Could not load Codex sessions.");
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [project.id, retry]);

  async function mutate(session?: Session, action?: "login" | "resume" | "stop") {
    setPending(session?.id ?? "new");
    setError("");
    try {
      const data = await request<{ session: Session; login?: Login }>(
        session ? `/api/codex-sessions/${encodeURIComponent(session.id)}` : "/api/codex-sessions",
        session ? { action } : { projectId: project.id, agentId },
      );
      setSessions((previous) => [data.session, ...previous.filter((item) => item.id !== data.session.id)]);
      if (data.login) {
        if (!safeLogin(data.login)) throw new Error("The sign-in service returned an unexpected verification address.");
        setLogins((previous) => ({ ...previous, [data.session.id]: data.login! }));
      } else if (session) {
        setLogins((previous) => { const next = { ...previous }; delete next[session.id]; return next; });
      }
      setRetry((previous) => previous + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the Codex session.");
    } finally { setPending(null); }
  }

  const existing = sessions.some((session) => session.agentId === agentId);
  return (
    <section className="codex-panel" aria-labelledby="codex-sessions-title">
      <header className="codex-panel-heading">
        <Command aria-hidden="true" />
        <div><h2 id="codex-sessions-title">Codex agent</h2><p>Start a local Docker box here, then talk to Codex in the desktop app.</p></div>
      </header>
      <p className="muted">This is a separate CPU environment on this computer, not a cloud or GPU machine. Codex can run commands in its container workspace. It starts empty; ask Codex in the desktop app to clone your project repository when needed.</p>
      {(error || loadError) && <div className="alert error" role="alert">{error || loadError}<button type="button" className="button secondary" onClick={() => { setError(""); setRetry((previous) => previous + 1); }}>Retry</button></div>}
      {enabled === null && !error && !loadError && <p role="status">Checking local Codex setup…</p>}
      {enabled === false && <div className="info-note"><div><strong>Local Codex setup is not enabled</strong><p>On the backend computer, run <code>npm run codex:setup</code>, then restart the server with <code>AGENTCLOUD_CODEX_ENABLED=1</code>.</p></div></div>}
      {enabled && <>
        {!owner && <p className="muted">A project owner can initialize and manage these boxes. Members can chat with a ready agent in the desktop app.</p>}
        {owner && (agents.length ? <form className="codex-create" onSubmit={(event) => { event.preventDefault(); void mutate(); }}>
          <Select aria-label="Codex agent to initialize" value={agentId} onChange={(event) => setSelectedAgent(event.target.value)} disabled={pending !== null}>
            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
          </Select>
          <button className="button primary" disabled={pending !== null || existing}><Play aria-hidden="true" />{pending === "new" ? "Initializing…" : existing ? "Box already created" : "Initialize Codex"}</button>
        </form> : <p className="info-note">Register a Codex identity below, then initialize its box here.</p>)}
        <div className="codex-session-list">
          {sessions.map((session) => {
            const login = session.status === "auth_required" ? logins[session.id] : undefined;
            const tone = session.status === "ready" ? "green" : session.status === "error" ? "red" : session.status === "auth_required" ? "yellow" : "cyan";
            return <article key={session.id} className="codex-session-card">
              <div className="codex-session-heading"><h3>{project.agents.find((agent) => agent.id === session.agentId)?.name ?? "Codex agent"}</h3><span className={`tag ${tone}`} role="status">{labels[session.status]}</span></div>
              <p className="muted">Local Docker · persistent workspace</p>
              {session.error && <p className="alert error">{session.error}</p>}
              {session.status === "initializing" && <p>Starting Codex inside the container. Readiness appears after startup and sign-in complete.</p>}
              {session.status === "stopped" && <p>The box is stopped. Its workspace and Codex sign-in are retained for resume.</p>}
              {login && <div className="codex-login"><p>Open OpenAI sign-in and enter this device code:</p><code>{login.userCode}</code><a className="button secondary" href={login.verificationUrl} target="_blank" rel="noopener noreferrer">Open OpenAI sign-in <ArrowUpRight aria-hidden="true" /></a><p className="muted">Keep this page open. Status updates when sign-in finishes. If the code expires, request a new one.</p></div>}
              <div className="codex-session-actions">
                {owner && session.status === "auth_required" && <button className="button primary" disabled={pending !== null} onClick={() => void mutate(session, "login")}>{pending === session.id ? "Requesting sign-in…" : login ? "Get a new sign-in code" : "Sign in to Codex"}</button>}
                {(session.status === "ready" || session.status === "running") && serverUrl && <a className="button primary" href={`agentcloud://open?${new URLSearchParams({ projectId: project.id, codexSessionId: session.id, serverUrl })}`}><Desktop aria-hidden="true" />Open in desktop</a>}
                {owner && (session.status === "stopped" || session.status === "error") && <button className="button secondary" disabled={pending !== null} onClick={() => void mutate(session, "resume")}><Play aria-hidden="true" />Resume Codex</button>}
                {owner && session.status !== "stopped" && <button className="button danger" disabled={pending !== null} onClick={() => void mutate(session, "stop")}><Stop aria-hidden="true" />Stop box</button>}
              </div>
              {(session.status === "ready" || session.status === "running") && <details className="muted"><summary>Desktop didn’t open?</summary><p>Start the desktop app with <code>just desktop</code>, then select this project and Codex session.</p><p>Project ID: <code>{project.id}</code><br />Session ID: <code>{session.id}</code></p></details>}
            </article>;
          })}
        </div>
      </>}
    </section>
  );
}
