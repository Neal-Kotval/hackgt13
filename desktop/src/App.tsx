import { useCallback, useEffect, useState } from "react";
import { ShellNav, type AppSection } from "./components/ShellNav";
import { SignInScreen } from "./components/SignInScreen";
import { ProjectPicker } from "./components/ProjectPicker";
import { EnvironmentsPanel } from "./components/EnvironmentsPanel";
import { ProjectChat } from "./components/ProjectChat";
import { desktopApi } from "./lib/desktop-api";
import type { AuthStatus, DeepLinkParseResult } from "./lib/types";

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [section, setSection] = useState<AppSection>("local-chat");
  const [codexLink, setCodexLink] = useState<DeepLinkParseResult | null>(null);
  const [taskLink, setTaskLink] = useState<DeepLinkParseResult | null>(null);
  const [environmentLink, setEnvironmentLink] = useState<DeepLinkParseResult | null>(null);
  const [environmentsMounted, setEnvironmentsMounted] = useState(false);
  const clearCodexLink = useCallback(() => setCodexLink(null), []);
  const clearTaskLink = useCallback(() => setTaskLink(null), []);
  const clearEnvironmentLink = useCallback(() => setEnvironmentLink(null), []);
  const routeDeepLink = useCallback((result: DeepLinkParseResult) => {
    if (result.ok && result.target.codexSessionId) {setCodexLink(result);setSection("local-chat");}
    else if (result.ok && result.target.runBoxId) {setEnvironmentLink(result);setEnvironmentsMounted(true);setSection("environments");}
    else {setTaskLink(result);setSection("tasks");}
  }, []);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe = () => {};
    try {
    desktopApi().authStatus().then(status=>{if(!cancelled)setAuth(status);})
      .catch(cause=>{if(!cancelled)setBootError(cause instanceof Error ? cause.message : "Could not check your session.");});
    unsubscribe = desktopApi().onDeepLink(routeDeepLink);
    void desktopApi().takePendingDeepLink().then(link=>{if(!cancelled && link)routeDeepLink(link);}).catch(()=>{});
    } catch (cause) {
      setBootError(cause instanceof Error ? cause.message : "Desktop bridge unavailable.");
    }
    return ()=>{cancelled=true;unsubscribe();};
  }, [routeDeepLink]);
  async function signOut() {
    setSigningOut(true);setError(null);
    try {setAuth(await desktopApi().signOut());setEnvironmentsMounted(false);setSection("local-chat");setCodexLink(null);setTaskLink(null);setEnvironmentLink(null);}
    catch(cause){setError(cause instanceof Error ? cause.message : "Sign-out failed.");}
    finally{setSigningOut(false);}
  }
  if(bootError)return <div className="app-error" role="alert"><h1>Desktop unavailable</h1><p>{bootError}</p></div>;
  if(!auth)return <div className="auth-page" role="status"><p className="auth-loading">Checking employee session…</p></div>;
  if(!auth.signedIn)return <SignInScreen baseUrl={auth.baseUrl} secureStorage={auth.secureStorage} initialMessage={auth.message} onSignedIn={status=>{setAuth(status);setError(null);}} />;
  return <ProjectChat key={auth.user?.id} webBaseUrl={auth.baseUrl} deepLink={codexLink} onDeepLinkHandled={clearCodexLink}>{chat =>
    <ShellNav section={section} employeeName={auth.user?.name || "Signed in"} employeeEmail={auth.user?.email || ""} busy={chat.busy || signingOut}
      renderHistory={section === "local-chat" ? chat.sidebar : undefined}
      onSectionChange={next=>{setSection(next);if(next === "environments")setEnvironmentsMounted(true);}} onSignOut={()=>void signOut()}>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="section-host" hidden={section !== "local-chat"}>{chat.content}</div>
      {environmentsMounted && <div className="section-host" hidden={section !== "environments"}><EnvironmentsPanel webBaseUrl={auth.baseUrl} deepLink={environmentLink} onDeepLinkHandled={clearEnvironmentLink} /></div>}
      {section === "tasks" && <ProjectPicker webBaseUrl={auth.baseUrl} deepLink={taskLink} onDeepLinkHandled={clearTaskLink} />}
    </ShellNav>
  }</ProjectChat>;
}
