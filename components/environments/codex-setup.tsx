"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle, Desktop } from "@phosphor-icons/react";

type Session = {
  id: string;
  agentId: string;
  status: "initializing" | "auth_required" | "ready" | "running" | "error" | "stopped";
  error?: string | null;
  isSetupSession?: boolean;
  target?: { kind: string; runBoxId?: string };
};
async function request<T>(url: string, body?: object): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not connect Codex to this environment.");
  return data as T;
}

/** Settings owns setup; desktop supplies the browser OAuth callback tunnel. */
export function CodexEnvironmentSetup({ projectId, runBoxId, owner, desktopUrl }: {
  projectId: string; runBoxId: string; owner: boolean; desktopUrl: string;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [peers, setPeers] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [opening, setOpening] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const redirectAfterSignIn = useRef(false);
  const peerRequestId = useRef<string | null>(null);
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
        setPeers(matches.filter(item => item.isSetupSession && item.agentId !== (matches.find(candidate => candidate.isSetupSession) || matches[0])?.agentId));
        setLoadError("");
      } catch (cause) {
        if (active) { setLoadError(cause instanceof Error ? cause.message : "Could not check Codex sign-in."); setSession(null); setPeers([]); }
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
    setSigningIn(false);
    if (redirectAfterSignIn.current && desktopUrl) {
      redirectAfterSignIn.current = false;
      setOpening(true);
      window.location.assign(desktopUrl);
    }
  }, [ready, desktopUrl]);
  async function prepare() {
    setBusy(true); setError("");
    try {
      const result = session
        ? await request<{ session: Session }>(`/api/codex-sessions/${session.id}`, { action: "resume" })
        : await request<{ session: Session }>("/api/codex-sessions", { projectId, runBoxId });
      if (mounted.current) { setSession(result.session); setRefresh(value => value + 1); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not prepare Codex."); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function addPeer() {
    setBusy(true); setError("");
    peerRequestId.current ||= crypto.randomUUID();
    try {
      await request<{ session: Session }>("/api/codex-sessions", { projectId, runBoxId, newAgent: true, requestId: peerRequestId.current });
      peerRequestId.current = null;
      if (mounted.current) setRefresh(value => value + 1);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not add another agent."); }
    finally { if (mounted.current) setBusy(false); }
  }
  function signIn() {
    if (!session || !desktopUrl) return;
    setError("");
    // Identifiers only: desktop obtains the OAuth URL through its authenticated
    // API and binds the pinned SSH callback tunnel before opening the browser.
    const url = new URL(desktopUrl);
    url.searchParams.set("panel", "codex-login");
    url.searchParams.set("codexSessionId", session.id);
    setSigningIn(true);
    redirectAfterSignIn.current = true;
    window.location.assign(url.toString());
  }
  async function cancel() {
    if (!session) return;
    redirectAfterSignIn.current = false;
    setBusy(true);
    try { await request(`/api/codex-sessions/${session.id}`, { action: "cancelLogin" }); setSigningIn(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not cancel sign-in."); }
    finally { setBusy(false); }
  }
  return <section className="environment-codex" aria-label="Codex setup">
    <div className="resource-detail-title"><h4>Codex</h4><span className={`resource-badge ${ready ? "resource-badge--ready" : ""}`}>{loading ? "Checking sign-in" : ready ? "Signed in" : session?.status === "initializing" ? "Connecting" : "Setup needed"}</span></div>
    <p className="resource-note">Sign in with ChatGPT to use Codex in this environment. Chats share its account and workspace.</p>
    {(error || loadError) && <p className="resource-feedback resource-feedback--error" role="alert">{error || loadError}</p>}
    {session?.status === "error" && !error && <p className="resource-feedback resource-feedback--error" role="alert">{session.error || "Reconnect this environment to continue setup."}</p>}
    {signingIn && !ready && <div className="environment-signin">
      <p>Complete sign-in in your browser. The desktop app connects the login to this environment.</p>
      <div className="environment-actions"><button className="button" type="button" onClick={signIn}>Open sign-in again</button><button className="button" type="button" disabled={busy} onClick={() => void cancel()}>Cancel sign-in</button></div>
      <p className="resource-note" role="status">Waiting for sign-in. If nothing opened, start the desktop app and try again.</p>
    </div>}
    <div className="environment-actions">
      {ready && desktopUrl ? <a className="button primary" href={desktopUrl}><Desktop aria-hidden="true" />Open in desktop</a> : !loading && owner && !signingIn && session?.status !== "initializing" ? <button className="button primary" type="button" disabled={busy} onClick={() => void (session?.status === "auth_required" ? signIn() : prepare())}>{busy ? "Connecting…" : session?.status === "auth_required" ? "Sign in with ChatGPT" : session ? "Reconnect Codex" : "Add Codex"}</button> : null}
      {!owner && !ready && !loading && <p className="resource-note">A project owner needs to finish Codex setup for this environment.</p>}
      {(error || loadError) && <button className="button" type="button" onClick={() => { setError(""); setRefresh(value => value + 1); }}>Check again</button>}
    </div>
    {ready && <div className="environment-codex-peers">
      <p className="resource-note">Each additional agent gets its own workspace and chat in this environment.</p>
      {peers.map((peer, index) => {
        const url = desktopUrl ? new URL(desktopUrl) : null;
        url?.searchParams.set("codexSessionId", peer.id);
        return <div className="environment-actions" key={peer.id}>
          <span>Codex {index + 2} · {peer.status === "ready" || peer.status === "running" ? "Ready" : peer.status === "initializing" ? "Connecting" : peer.status === "auth_required" ? "Sign-in needed" : peer.status}</span>
          {url && <a className="button" href={url.toString()}>Open in desktop</a>}
        </div>;
      })}
      {owner && <div className="environment-actions"><button className="button" type="button" disabled={busy} onClick={() => void addPeer()}>{busy ? "Adding agent…" : "Add another Codex agent"}</button></div>}
    </div>}
    {opening && ready && <p className="resource-note" role="status"><CheckCircle aria-hidden="true" />Signed in. If desktop didn’t open, use Open in desktop above.</p>}
  </section>;
}
