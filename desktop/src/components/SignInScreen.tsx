import { useState, type FormEvent } from "react";
import { desktopApi } from "../lib/desktop-api";
import type { AuthStatus } from "../lib/types";

type SignInScreenProps = {
  baseUrl: string;
  secureStorage: boolean;
  initialMessage?: string;
  onSignedIn: (status: AuthStatus) => void;
};

export function SignInScreen({
  baseUrl,
  secureStorage,
  initialMessage,
  onSignedIn,
}: SignInScreenProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(initialMessage ?? null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await desktopApi().signIn(email, password);
      onSignedIn(result.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-panel" aria-labelledby="desktop-sign-in-title">
        <p className="eyebrow">agentcloud</p>
        <h1 id="desktop-sign-in-title">Sign in</h1>
        <p>
          Use the same employee account as the web app at{" "}
          <code>{baseUrl}</code>. Agent CLI tokens are not accepted here.
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="desktop-auth-email">
            Email
            <input
              id="desktop-auth-email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              disabled={pending}
            />
          </label>
          <label htmlFor="desktop-auth-password">
            Password
            <input
              id="desktop-auth-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={pending}
            />
          </label>
          <button
            type="submit"
            className="button primary"
            disabled={pending || !email.trim() || !password}
          >
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="auth-notice" role="status">
            {notice}
          </p>
        ) : null}
        <p className="auth-meta">
          {secureStorage
            ? "Session cookies are stored with OS-backed encryption outside chat history."
            : "Session cookies are stored outside chat history (encryption unavailable on this host)."}{" "}
          Keep the web app running ({baseUrl}) while signed in.
        </p>
      </section>
    </div>
  );
}
