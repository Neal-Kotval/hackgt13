"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, Copy, Desktop } from "@phosphor-icons/react";

type Session = {
  id: string;
  agentId: string;
  status: "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped";
  error?: string | null;
  isSetupSession?: boolean;
  target?: { kind: string; runBoxId?: string };
};
type Login = { verificationUrl: string; userCode: string };
async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not connect Codex to this environment.");
  return data as T;
}

/** Setup lives on the environment card; desktop only receives an authenticated target. */
export function CodexEnvironmentSetup({ projectId, runBoxId, agentId, owner, desktopUrl }: {
  projectId: string; runBoxId: string; agentId?: string; owner: boolean; desktopUrl: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [login, setLogin] = useState<Login | null>(null);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const redirectAfterSignIn = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<{ sessions: Session[] }>(`/api/codex-sessions?projectId=${encodeURIComponent(projectId)}`);
        if (!active) return;
        const matches = data.sessions.filter(item => item.target?.kind === "runBox" && item.target.runBoxId === runBoxId);
        setSession(matches.find(item => item.isSetupSession) || matches[0] || null);
        setLoadError("");
      } catch (cause) {
        if (active) { setLoadError(cause instanceof Error ? cause.message : "Could not check Codex sign-in."); setSession(null); }
      } finally {
        if (active) { setLoading(false); timer = setTimeout(poll, 2500); }
      }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [projectId, runBoxId, refresh]);
  const ready = session?.status === "ready" || session?.status === "running";
  useEffect(() => {
    if (!ready) return;
    setLogin(null);
    if (redirectAfterSignIn.current && desktopUrl) {
      redirectAfterSignIn.current = false;
      setOpening(true);
      window.location.assign(desktopUrl);
    }
  }, [ready, desktopUrl]);
  async function prepare() {
    setBusy(true); setError("");
    try {
      let id = agentId;
      if (!id) {
        const state = await request<{ projects: { id: string; agents: { id: string; client: string }[] }[] }>("/api/state");
        id = state.projects.find(item => item.id === projectId)?.agents.find(item => item.client === "Codex")?.id;
        if (!id) {
          const result = await request<{ agentId: string }>("/api/state", { type: "addAgent", projectId, client: "Codex", role: "Project coding agent" });
          id = result.agentId;
        }
      }
      const result = session
        ? await request<{ session: Session }>(`/api/codex-sessions/${session.id}`, { action: "resume" })
        : await request<{ session: Session }>("/api/codex-sessions", { projectId, agentId: id, runBoxId });
      if (mounted.current) { setSession(result.session); setRefresh(value => value + 1); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not prepare Codex."); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function signIn() {
    if (!session) return;
    setBusy(true); setError("");
    try {
      const result = await request<{ login: Login }>(`/api/codex-sessions/${session.id}`, { action: "login", method: "deviceCode" });
      const url = new URL(result.login.verificationUrl);
      if (url.origin !== "https://auth.openai.com" || !url.pathname.startsWith("/codex/") || url.username || url.password) throw new Error("Codex returned an unsupported sign-in link.");
      if (mounted.current) { setLogin(result.login); setCopied(false); redirectAfterSignIn.current = true; }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not start sign-in."); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function cancel() {
    if (!session) return;
    redirectAfterSignIn.current = false;
    setBusy(true);
    try { await request(`/api/codex-sessions/${session.id}`, { action: "cancelLogin" }); setLogin(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel sign-in."); }
    finally { setBusy(false); }
  }
  return <section className="environment-codex" aria-label="Codex setup">
    <div className="resource-detail-title"><h4>Codex</h4><span className={`resource-badge ${ready ? "resource-badge--ready" : ""}`}>{loading ? "Checking sign-in" : ready ? "Signed in" : session?.status === "initializing" ? "Connecting" : "Setup needed"}</span></div>
    <p className="resource-note">Set up this environment here, then create and manage your chats in the desktop app.</p>
    {(error || loadError) && <p className="resource-feedback resource-feedback--error" role="alert">{error || loadError}</p>}
    {session?.status === "error" && !error && <p className="resource-feedback resource-feedback--error" role="alert">{session.error || "Reconnect this environment to continue setup."}</p>}
    {login && !ready && <div className="environment-signin">
      <p>Enter this code on the ChatGPT sign-in page. Your sign-in is shared by chats in this project environment and ends when the environment is removed.</p>
      <div className="environment-actions"><code className="environment-signin-code">{login.userCode}</code><button className="button" type="button" onClick={() => void navigator.clipboard.writeText(login.userCode).then(() => setCopied(true)).catch(() => setError("Could not copy the code. Select and copy it manually."))}><Copy aria-hidden="true" />{copied ? "Copied" : "Copy code"}</button></div>
      <div className="environment-actions"><a className="button primary" href={login.verificationUrl} target="_blank" rel="noreferrer">Open ChatGPT sign-in</a><button className="button" type="button" disabled={busy} onClick={() => void cancel()}>Cancel sign-in</button></div>
      <p className="resource-note" role="status">Waiting for sign-in. We’ll open desktop when it completes.</p>
    </div>}
    <div className="environment-actions">
      {ready && desktopUrl ? <a className="button primary" href={desktopUrl}><Desktop aria-hidden="true" />Open in desktop</a> : !loading && owner && !login && session?.status !== "initializing" ? <button className="button primary" type="button" disabled={busy} onClick={() => void (session?.status === "auth_required" ? signIn() : prepare())}>{busy ? "Connecting…" : session?.status === "auth_required" ? "Sign in with ChatGPT" : session ? "Reconnect Codex" : "Set up Codex"}</button> : null}
      {!owner && !ready && !loading && <p className="resource-note">A project owner needs to finish Codex setup for this environment.</p>}
      {(error || loadError) && <button className="button" type="button" onClick={() => { setError(""); setRefresh(value => value + 1); }}>Check again</button>}
    </div>
    {opening && ready && <p className="resource-note" role="status"><CheckCircle aria-hidden="true" />Signed in. If desktop didn’t open, use Open in desktop above.</p>}
  </section>;
}
