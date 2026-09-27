import { useCallback, useEffect, useRef, useState } from "react";
import { CodexBrowserLogin } from "./components/CodexBrowserLogin";
import type { LoginTarget } from "./lib/browser-login-flow";
import { ShellNav, type AppSection } from "./components/ShellNav";
import { SignInScreen } from "./components/SignInScreen";
import { EnvironmentsPanel } from "./components/EnvironmentsPanel";
import { ProjectChatTerminal } from "./components/ProjectChatTerminal";
import { ProjectChat } from "./components/ProjectChat";
import { desktopApi } from "./lib/desktop-api";
import { deepLinkDestination, deepLinkServerError } from "./lib/deep-link";
import type { AuthStatus, DeepLinkParseResult } from "./lib/types";

export default function App() {
  // Keep the one-shot IPC result across StrictMode effect cleanup/replay.
  const initialLink = useRef<Promise<DeepLinkParseResult | null> | null>(null);
  const receivedLiveLink = useRef(false);
  const [loginTarget, setLoginTarget] = useState<LoginTarget | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [section, setSection] = useState<AppSection>("local-chat");
  const [codexLink, setCodexLink] = useState<DeepLinkParseResult | null>(null);
  const [chatRunBox, setChatRunBox] = useState<{
    projectId: string;
    runBoxId: string;
  } | null>(null);
  const [environmentLink, setEnvironmentLink] =
    useState<DeepLinkParseResult | null>(null);
  const [environmentsMounted, setEnvironmentsMounted] = useState(false);
  // An older project fetch can finish in the same batch as a new startup link.
  // Acknowledge only the link that render received, never a newer destination.
  const clearCodexLink = useCallback(() => {
    setCodexLink((current) => current === codexLink ? null : current);
  }, [codexLink]);
  const clearEnvironmentLink = useCallback(() => setEnvironmentLink(null), []);
  const routeDeepLink = useCallback(async (result: DeepLinkParseResult) => {
    if (result.ok) {
      try {
        const status = await desktopApi().authStatus();
        const mismatch = deepLinkServerError(result.target, status.baseUrl);
        if (mismatch) {
          setSection("local-chat");
          setError(mismatch);
          return;
        }
      } catch {
        setSection("local-chat");
        setError(
          "Could not check the alto server for this link. Retry after desktop connects.",
        );
        return;
      }
    }
    setError(null);
    if (!result.ok) {
      setError(result.error);
      setSection("local-chat");
      return;
    }
    const destination = deepLinkDestination(result.target);
    if (destination === "codex-browser-login" && result.target.runBoxId && result.target.codexSessionId) {
      setLoginTarget({ projectId: result.target.projectId, runBoxId: result.target.runBoxId, codexSessionId: result.target.codexSessionId });
      setSection("local-chat");
      return;
    }
    setLoginTarget(null);
    if (
      destination === "project-chat-session" ||
      destination === "project-chat-environment-codex"
    ) {
      // Project chat targets the environment itself once projects load.
      setChatRunBox(null);
      setCodexLink(result);
      setSection("local-chat");
    } else if (
      destination === "project-chat-environment-terminal" &&
      result.target.runBoxId
    ) {
      setCodexLink(result);
      setChatRunBox({
        projectId: result.target.projectId,
        runBoxId: result.target.runBoxId,
      });
      setSection("local-chat");
    } else if (result.target.taskRunBoxId) {
      setCodexLink({
        ok: true,
        target: { projectId: result.target.projectId },
      });
      setChatRunBox({
        projectId: result.target.projectId,
        runBoxId: result.target.taskRunBoxId,
      });
      setSection("local-chat");
    } else if (result.target.environmentId) {
      setError(
        "This legacy link names a catalog resource. Select its environment from the list below.",
      );
      setEnvironmentLink({
        ok: true,
        target: { projectId: result.target.projectId },
      });
      setEnvironmentsMounted(true);
      setSection("environments");
    } else {
      setChatRunBox(null);
      setCodexLink(result);
      setSection("local-chat");
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    try {
      desktopApi()
        .authStatus()
        .then((status) => {
          if (!cancelled) setAuth(status);
        })
        .catch((cause) => {
          if (!cancelled)
            setBootError(
              cause instanceof Error
                ? cause.message
                : "Could not check your session.",
            );
        });
      unsubscribe = desktopApi().onDeepLink((link) => {
        receivedLiveLink.current = true;
        void routeDeepLink(link);
      });
      initialLink.current ??= desktopApi().takePendingDeepLink();
      void initialLink.current
        .then((link) => {
          if (!cancelled && !receivedLiveLink.current && link) routeDeepLink(link);
        })
        .catch(() => {});
    } catch (cause) {
      setBootError(
        cause instanceof Error ? cause.message : "Desktop bridge unavailable.",
      );
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [routeDeepLink]);
  const finishLogin = useCallback(() => {
    if (!loginTarget) return;
    setCodexLink({ ok: true, target: { projectId: loginTarget.projectId, runBoxId: loginTarget.runBoxId, panel: "codex" } });
    setChatRunBox(null);
    setLoginTarget(null);
    setSection("local-chat");
  }, [loginTarget]);
  async function signOut() {
    setSigningOut(true);
    setError(null);
    try {
      setAuth(await desktopApi().signOut());
      setChatRunBox(null);
      setEnvironmentsMounted(false);
      setSection("local-chat");
      setCodexLink(null);
      setLoginTarget(null);
      setEnvironmentLink(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out failed.");
    } finally {
      setSigningOut(false);
    }
  }
  if (bootError)
    return (
      <div className="app-error" role="alert">
        <h1>Desktop unavailable</h1>
        <p>{bootError}</p>
      </div>
    );
  if (!auth)
    return (
      <div className="auth-page" role="status">
        <p className="auth-loading">Checking employee session…</p>
      </div>
    );
  if (!auth.signedIn)
    return (
      <SignInScreen
        baseUrl={auth.baseUrl}
        secureStorage={auth.secureStorage}
        initialMessage={auth.message}
        onSignedIn={(status) => {
          setAuth(status);
          setError(null);
        }}
      />
    );
  return (
    <ProjectChat
      key={auth.user?.id}
      webBaseUrl={auth.baseUrl}
      deepLink={codexLink}
      onDeepLinkHandled={clearCodexLink}
      onSelectConversation={() => { setChatRunBox(null); setLoginTarget(null); }}
      onSignIn={(target) => {
        setChatRunBox(null);
        setSection("local-chat");
        setLoginTarget(target);
      }}
      onOpenTerminal={(projectId, runBoxId) => {
        setChatRunBox({ projectId, runBoxId });
        setSection("local-chat");
      }}
    >
      {(chat) => (
        <ShellNav
          section={section}
          employeeName={auth.user?.name || "Signed in"}
          employeeEmail={auth.user?.email || ""}
          busy={chat.busy || signingOut}
          renderHistory={section === "local-chat" ? chat.sidebar : undefined}
          onSectionChange={(next) => {
            setLoginTarget(null);
            setSection(next);
            if (next === "environments") setEnvironmentsMounted(true);
          }}
          onSignOut={() => void signOut()}
        >
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          {loginTarget && <CodexBrowserLogin target={loginTarget} onComplete={finishLogin} onClose={() => setLoginTarget(null)} />}
          <div
            className="section-host"
            hidden={Boolean(loginTarget) || section !== "local-chat" || Boolean(chatRunBox)}
          >
            {chat.content}
          </div>
          {chatRunBox && !loginTarget && (
            <div className="section-host" hidden={section !== "local-chat"}>
              <div className="app-shell">
                <main className="main">
                  <header className="main-header">
                    <h1>Environment terminal</h1>
                  </header>
                  <ProjectChatTerminal
                    key={`${chatRunBox.projectId}:${chatRunBox.runBoxId}`}
                    projectId={chatRunBox.projectId}
                    runBoxId={chatRunBox.runBoxId}
                    onClose={() => setChatRunBox(null)}
                  />
                </main>
              </div>
            </div>
          )}
          {environmentsMounted && !loginTarget && (
            <div className="section-host" hidden={section !== "environments"}>
              <EnvironmentsPanel
                webBaseUrl={auth.baseUrl}
                deepLink={environmentLink}
                onDeepLinkHandled={clearEnvironmentLink}
                onOpenCodex={(projectId, runBoxId) =>
                  void routeDeepLink({
                    ok: true,
                    target: { projectId, runBoxId, panel: "codex" },
                  })
                }
              />
            </div>
          )}
        </ShellNav>
      )}
    </ProjectChat>
  );
}
