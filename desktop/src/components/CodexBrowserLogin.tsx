import { useEffect, useRef, useState } from "react";
import { beginBrowserLogin, type LoginTarget } from "../lib/browser-login-flow";
import { desktopApi } from "../lib/desktop-api";

export function CodexBrowserLogin({ target, onComplete, onClose }: { target: LoginTarget; onComplete: () => void; onClose: () => void }) {
  const [message, setMessage] = useState("Checking your environment…");
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const flow = useRef<ReturnType<typeof beginBrowserLogin> | null>(null);
  useEffect(() => {
    setMessage("Checking your environment…");
    setError(null);
    setClosing(false);
    const operation = beginBrowserLogin(desktopApi(), target, setMessage, onComplete, setError);
    flow.current = operation;
    return () => { void operation.cancel(); };
  }, [target, onComplete]);
  return <div className="auth-page"><section className="auth-panel" aria-labelledby="codex-login-heading">
    <p className="eyebrow">Environment sign-in</p>
    <h1 id="codex-login-heading">Connect your ChatGPT account</h1>
    {error ? <p className="error-banner" role="alert">{error}</p> : <p role="status">{message}</p>}
    <button className="button secondary" disabled={closing} onClick={async () => { setClosing(true); await flow.current?.cancel(); onClose(); }}>{closing ? "Closing…" : error ? "Close" : "Cancel sign-in"}</button>
  </section></div>;
}
