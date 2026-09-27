"use client";

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type { FitAddon } from "@xterm/addon-fit";
import type { ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { RunBoxJob } from "./types";
import "./terminal.css";

// Web terminal for one environment (environment model, slice C). The Next server
// holds the SSH connection and the runner key; the browser only exchanges text with
// it: POST .../terminal opens a PTY, an event stream carries output, and POSTs carry
// keystrokes and resizes.
type Status =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; expiresAt: string | null }
  | { kind: "disconnected"; message: string }
  | { kind: "not-ready"; message: string }
  | { kind: "forbidden"; message: string };

type Session = { id: string; source: EventSource; closed: boolean };

const IDLE_MINUTES = 15;

function colorNormalizer(): (value: string) => string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  return (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || !context) return undefined;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = trimmed;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  };
}

// xterm needs concrete colors, so resolve the semantic tokens that apply to the
// terminal surface (the light .alto-web aliases on the web) at runtime.
function themeFromTokens(element: HTMLElement): ITheme {
  const styles = getComputedStyle(element);
  const toColor = colorNormalizer();
  const token = (name: string) => toColor(styles.getPropertyValue(name));
  return {
    background: token("--color-surface"),
    foreground: token("--color-text"),
    cursor: token("--color-accent"),
    cursorAccent: token("--color-surface"),
    selectionBackground: token("--color-accent-soft"),
    black: token("--color-text"),
    red: token("--color-danger"),
    green: token("--color-success"),
    yellow: token("--color-warning"),
    blue: token("--color-accent"),
    magenta: token("--color-agent-secondary"),
    cyan: token("--color-info"),
    white: token("--color-muted"),
    brightBlack: token("--color-subtle"),
    brightRed: token("--color-danger"),
    brightGreen: token("--color-success"),
    brightYellow: token("--color-warning"),
    brightBlue: token("--color-accent-hover"),
    brightMagenta: token("--color-agent-secondary"),
    brightCyan: token("--color-info"),
    brightWhite: token("--color-secondary"),
  };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function errorMessage(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: unknown; code?: unknown };
    return { message: typeof payload.error === "string" ? payload.error : fallback, code: typeof payload.code === "string" ? payload.code : undefined };
  } catch {
    return { message: fallback, code: undefined };
  }
}

function jobReady(job: RunBoxJob) {
  return job.state === "ready" && !job.stop_requested_at;
}

export function EnvironmentTerminal({ projectId, job }: { projectId: string; job: RunBoxJob }): JSX.Element {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const leaveRef = useRef<HTMLButtonElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const inputQueue = useRef("");
  const sending = useRef(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [terminalReady, setTerminalReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const allowed = job.permissions?.open !== false;
  const ready = jobReady(job);
  const base = `/api/run-boxes/${encodeURIComponent(job.id)}/terminal`;

  const endSession = useCallback((notifyServer: boolean) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    inputQueue.current = "";
    if (!session || session.closed) return;
    session.closed = true;
    if (!notifyServer) {
      session.source.close();
      return;
    }
    // Ask the server to close first so the audit row says why; dropping the stream
    // would close the session anyway.
    void fetch(`${base}/${encodeURIComponent(session.id)}`, { method: "DELETE", keepalive: true })
      .catch(() => undefined)
      .finally(() => session.source.close());
  }, [base]);

  const flushInput = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      // One request in flight at a time keeps keystrokes in order.
      while (inputQueue.current && sessionRef.current && !sessionRef.current.closed) {
        const session = sessionRef.current;
        const data = inputQueue.current.slice(0, 8192);
        inputQueue.current = inputQueue.current.slice(data.length);
        let response: Response;
        try {
          response = await fetch(`${base}/${encodeURIComponent(session.id)}/input`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }),
          });
        } catch {
          endSession(false);
          setStatus({ kind: "disconnected", message: "Lost contact with alto. Your keystrokes were not delivered." });
          return;
        }
        if (!response.ok && sessionRef.current === session) {
          const { message } = await errorMessage(response, "The terminal session ended.");
          endSession(false);
          setStatus(response.status === 403 ? { kind: "forbidden", message } : { kind: "disconnected", message });
          return;
        }
      }
    } finally {
      sending.current = false;
    }
  }, [base, endSession]);

  // Create the xterm instance once, client side only.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !allowed || !ready) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    const subscriptions: { dispose(): void }[] = [];
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      const styles = getComputedStyle(surface);
      const fontSize = Number.parseFloat(styles.fontSize);
      const terminal = new Terminal({
        theme: themeFromTokens(surface),
        fontFamily: styles.fontFamily,
        fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 12,
        cursorBlink: true,
        scrollback: 5000,
        screenReaderMode: false,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(surface);
      terminal.textarea?.setAttribute("aria-label", "Environment terminal input");
      // Shift+Escape moves focus out of the terminal; every other key goes to the shell.
      terminal.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && event.key === "Escape" && event.shiftKey) {
          leaveRef.current?.focus();
          return false;
        }
        return true;
      });
      terminalRef.current = terminal;
      fitRef.current = fit;
      const refit = () => {
        if (surface.clientWidth > 0 && surface.clientHeight > 0) {
          try { fit.fit(); } catch { /* Not yet measurable. */ }
        }
      };
      refit();
      observer = new ResizeObserver(refit);
      observer.observe(surface);
      subscriptions.push(terminal.onData((data) => {
        if (!sessionRef.current) return;
        inputQueue.current += data;
        void flushInput();
      }));
      subscriptions.push(terminal.onResize(({ cols, rows }) => {
        if (resizeTimer.current) clearTimeout(resizeTimer.current);
        resizeTimer.current = setTimeout(() => {
          const session = sessionRef.current;
          if (!session) return;
          void fetch(`${base}/${encodeURIComponent(session.id)}/resize`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols, rows }),
          }).catch(() => undefined);
        }, 150);
      }));
      setTerminalReady(true);
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      for (const item of subscriptions) item.dispose();
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      setTerminalReady(false);
    };
  }, [allowed, ready, base, flushInput]);

  // Open a session once the terminal exists, and again on each reconnect.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminalReady || !terminal) return;
    let active = true;
    setStatus({ kind: "connecting" });
    if (attempt > 0) terminal.write("\r\n");
    void (async () => {
      let response: Response;
      try {
        try { fitRef.current?.fit(); } catch { /* Not yet measurable. */ }
        response = await fetch(base, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId, cols: terminal.cols, rows: terminal.rows }),
        });
      } catch {
        if (active) setStatus({ kind: "disconnected", message: "Could not reach alto to open the terminal." });
        return;
      }
      if (!response.ok) {
        const { message, code } = await errorMessage(response, "Could not open the terminal.");
        if (!active) return;
        if (response.status === 403 || response.status === 404) setStatus({ kind: "forbidden", message });
        else if (response.status === 409 && code === "not_ready") setStatus({ kind: "not-ready", message });
        else setStatus({ kind: "disconnected", message });
        return;
      }
      const opened = (await response.json()) as { sessionId: string; expiresAt: string | null };
      const source = new EventSource(`${base}/${encodeURIComponent(opened.sessionId)}/stream`);
      const session: Session = { id: opened.sessionId, source, closed: false };
      if (!active) {
        sessionRef.current = session;
        endSession(true);
        return;
      }
      sessionRef.current = session;
      source.onopen = () => {
        if (!active || session.closed) return;
        setStatus({ kind: "connected", expiresAt: opened.expiresAt });
        terminal.focus();
      };
      source.onmessage = (event) => {
        if (!session.closed) terminal.write(decodeBase64(String(event.data)));
      };
      source.addEventListener("close", (event) => {
        let message = "The terminal session ended.";
        try { message = (JSON.parse(String((event as MessageEvent).data)) as { message?: string }).message || message; } catch { /* Keep default. */ }
        if (sessionRef.current === session) endSession(false);
        if (active) setStatus({ kind: "disconnected", message });
      });
      // EventSource would silently retry; a dropped stream has already closed the shell.
      source.onerror = () => {
        if (session.closed) return;
        if (sessionRef.current === session) endSession(true);
        if (active) setStatus({ kind: "disconnected", message: "The connection to the terminal was lost." });
      };
    })();
    return () => {
      active = false;
      endSession(true);
    };
  }, [terminalReady, attempt, base, projectId, endSession]);

  const reconnect = () => {
    endSession(true);
    setAttempt((value) => value + 1);
  };

  const disconnect = () => {
    endSession(true);
    setStatus({ kind: "disconnected", message: "Terminal closed." });
  };

  if (!allowed)
    return (
      <section className="environment-terminal" aria-label="Terminal">
        <div className="environment-terminal-notice" role="status">
          <strong>No terminal access</strong>
          <p className="muted">This environment is private to its creator. Ask them to make it public to open a terminal.</p>
        </div>
      </section>
    );

  if (!ready)
    return (
      <section className="environment-terminal" aria-label="Terminal">
        <div className="environment-terminal-notice" role="status">
          <strong>Environment not ready</strong>
          <p className="muted">
            {job.stop_requested_at || job.state === "stopping" || job.state === "stopped"
              ? "This environment is stopped or stopping, so its terminal is closed."
              : `The terminal opens once the environment is ready. It is ${job.state} now.`}
          </p>
        </div>
      </section>
    );

  const label = status.kind === "connected" ? "Connected" : status.kind === "connecting" || status.kind === "idle" ? "Connecting…"
    : status.kind === "not-ready" ? "Not ready" : status.kind === "forbidden" ? "No access" : "Disconnected";

  return (
    <section className="environment-terminal" aria-label="Terminal">
      <div className="environment-terminal-bar">
        <span className={`environment-terminal-state ${status.kind}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          {label}
        </span>
        <p className="environment-terminal-trust">
          Trusted shell access as the environment&apos;s <code>agentcloud</code> user. This is not a sandbox.
        </p>
        <div className="environment-terminal-actions">
          {status.kind === "connected" || status.kind === "connecting" ? (
            <button ref={leaveRef} type="button" className="button ghost" onClick={disconnect}>Disconnect</button>
          ) : (
            <button ref={leaveRef} type="button" className="button primary" onClick={reconnect}
              disabled={status.kind === "forbidden" || status.kind === "idle"}>
              Reconnect
            </button>
          )}
        </div>
      </div>
      {status.kind === "disconnected" || status.kind === "not-ready" || status.kind === "forbidden" ? (
        <p className={`environment-terminal-message ${status.kind}`} role="alert">{status.message}</p>
      ) : null}
      <div ref={surfaceRef} className="environment-terminal-surface" data-state={status.kind}
        onClick={() => terminalRef.current?.focus()} />
      <p className="environment-terminal-hint muted">
        Shift+Esc moves focus out of the terminal. Sessions close after {IDLE_MINUTES} minutes without input
        {status.kind === "connected" && status.expiresAt
          ? ` and when the environment's time limit is reached at ${new Date(status.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
          : " and when the environment stops"}.
      </p>
    </section>
  );
}
