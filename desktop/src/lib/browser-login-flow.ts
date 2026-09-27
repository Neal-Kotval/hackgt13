import { parseBrowserLogin } from "./chatgpt-sign-in.ts";
import { parseCodexSession } from "./codex-targets.ts";
import type { DesktopApi } from "./types";

export type LoginTarget = { projectId: string; runBoxId: string; codexSessionId: string };
export type LoginBridge = Pick<DesktopApi, "fetchHuman" | "startChatGptBrowserSignIn" | "stopChatGptBrowserSignIn" | "onChatGptSignInEvent">;

/** Identifiers are untrusted until resolved through the authenticated API. */
export function validateLoginSession(value: unknown, target: LoginTarget) {
  const session = parseCodexSession(value);
  if (!session || session.id !== target.codexSessionId || session.projectId !== target.projectId || session.target.kind !== "runBox" || session.target.runBoxId !== target.runBoxId)
    throw new Error("This Codex session does not belong to the selected project environment. Open sign-in again from Settings.");
  return session;
}

const activeFlows = new Map<string, { done: Promise<void>; cancel: () => Promise<void> }>();

/** One web-initiated login owns its tunnel, polling, and cancellation. */
export function beginBrowserLogin(bridge: LoginBridge, target: LoginTarget, notify: (message: string) => void, complete: () => void, failed: (error: string) => void, pollMs = 1500) {
  const prior = activeFlows.get(target.codexSessionId);
  void prior?.cancel();
  let cancelled = false, finished = false, loginStarted = false;
  let wake: (() => void) | undefined;
  const path = `/api/codex-sessions/${encodeURIComponent(target.codexSessionId)}`;
  async function request(body?: object) {
    const response = await bridge.fetchHuman(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- server JSON, validated by callers
    let data: Record<string, any>;
    try { data = JSON.parse(response.body); }
    catch {
      // A proxy error page (for example CloudFront's 504 after 30 s) is HTML, not JSON.
      throw new Error(`AgentCloud didn't respond in time (HTTP ${response.status}). Try again in a moment.`);
    }
    if (!response.ok) throw Object.assign(new Error(data.error || "Codex sign-in request failed."), { code: data.code });
    return data;
  }
  const pause = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
  // Codex may still be connecting (SSH + app-server take tens of seconds on a fresh environment).
  async function currentSession() {
    for (let attempt = 0; ; attempt++) {
      const session = validateLoginSession((await request()).session, target);
      if (session.status !== "initializing" || cancelled || attempt >= 120) return session;
      notify("Codex is still connecting to your environment…");
      await pause(pollMs);
    }
  }
  async function startLogin() {
    for (let attempt = 0; ; attempt++) {
      try { return await request({ action: "login", method: "browser" }); }
      catch (error) {
        if ((error as { code?: string }).code !== "connecting" || cancelled || attempt >= 120) throw error;
        notify("Codex is still connecting to your environment…");
        await pause(pollMs);
      }
    }
  }
  let unsubscribe = () => {};
  const subscribe = () => bridge.onChatGptSignInEvent(event => {
    if (event.sessionId !== target.codexSessionId || cancelled || finished) return;
    if (event.type === "closed") {
      failed(event.error || "The sign-in connection closed. Retry from project Settings.");
      cancelled = true;
      wake?.();
    } else notify("Preparing secure access to your environment…");
  });
  const done = (async () => {
    try {
      await prior?.done;
      if (cancelled) return;
      unsubscribe = subscribe();
      const initial = await currentSession();
      if (cancelled) return;
      if (initial.status === "ready" || initial.status === "running") { finished = true; return; }
      notify("Opening ChatGPT sign-in in your browser…");
      loginStarted = true;
      const result = await startLogin();
      if (cancelled) return;
      const login = parseBrowserLogin(result.login);
      if (!login) throw new Error("The environment did not return a valid browser sign-in. Retry from Settings.");
      await bridge.startChatGptBrowserSignIn({ sessionId: target.codexSessionId, runBoxId: target.runBoxId, authUrl: login.authUrl, callbackPort: login.callbackPort });
      if (cancelled) return;
      notify("Finish signing in to ChatGPT in your browser. This window will continue automatically.");
      while (!cancelled) {
        const snapshot = await request();
        const session = validateLoginSession(snapshot.session, target);
        if (cancelled) return;
        if (session.status === "ready" || session.status === "running") { finished = true; break; }
        if (snapshot.session.loginPending === false) throw new Error("Sign-in was cancelled or expired. Start it again from project Settings.");
        if (session.status === "error" || session.status === "stopped") throw new Error(session.error || "Codex sign-in stopped. Retry from project Settings.");
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, pollMs); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    } catch (error) {
      if (!cancelled) failed(error instanceof Error ? error.message : "Could not sign in to Codex.");
    } finally {
      unsubscribe();
      await bridge.stopChatGptBrowserSignIn(target.codexSessionId).catch(() => {});
      if (loginStarted && !finished) await request({ action: "cancelLogin" }).catch(() => {});
      if (finished && !cancelled) complete();
    }
  })();
  const flow = { done, cancel() { cancelled = true; wake?.(); return done; } };
  activeFlows.set(target.codexSessionId, flow);
  void done.finally(() => { if (activeFlows.get(target.codexSessionId) === flow) activeFlows.delete(target.codexSessionId); });
  return flow;
}
