import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { desktopApi } from "../lib/desktop-api";
import { environmentAccessLabel, type EnvironmentAccessState } from "../lib/environment-access";
import {
  ipcErrorMessage,
  terminalFontFrom,
  terminalThemeFromTokens,
} from "../lib/terminal-theme";

type TerminalStatus =
  | { kind: "connecting" }
  | { kind: "access"; state: EnvironmentAccessState }
  | { kind: "connected"; target: string }
  | { kind: "closed"; message?: string }
  | { kind: "error"; message: string };

type TerminalPanelProps = {
  runBoxId: string;
  title: string;
  onClose: () => void;
};

function newSessionId(): string {
  return crypto.randomUUID();
}

/**
 * In-app SSH terminal for one ready run box (HAC-90). The main process owns the
 * SSH connection, device key, and pinned host key; this panel only streams
 * text over the preload bridge.
 */
export function TerminalPanel({ runBoxId, title, onClose }: TerminalPanelProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus>({ kind: "connecting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    // The panel renders below the list; bring it into view without animation.
    panelRef.current?.scrollIntoView({ block: "nearest" });
    const font = terminalFontFrom(surface);
    const terminal = new Terminal({
      theme: terminalThemeFromTokens(),
      fontFamily: font.fontFamily,
      fontSize: font.fontSize,
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const refit = () => {
      if (surface.clientWidth > 0 && surface.clientHeight > 0) fit.fit();
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(surface);

    const api = desktopApi();
    const dataSub = terminal.onData((data) => {
      if (sessionRef.current) api.terminalWrite(sessionRef.current, data);
    });
    const resizeSub = terminal.onResize(({ cols, rows }) => {
      if (sessionRef.current) api.terminalResize(sessionRef.current, cols, rows);
    });

    return () => {
      observer.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const api = desktopApi();
    const sessionId = newSessionId();
    let active = true;

    setStatus({ kind: "connecting" });
    if (attempt > 0) terminal.write("\r\n");

    const stop = api.onTerminalEvent((event) => {
      if (event.sessionId !== sessionId) return;
      if (event.type === "data") {
        terminal.write(event.data);
        return;
      }
      if (event.type === "access") {
        if (active) setStatus({ kind: "access", state: event.state });
        return;
      }
      sessionRef.current = null;
      if (!active) return;
      setStatus(
        event.error
          ? { kind: "error", message: event.error }
          : { kind: "closed", message: "The remote shell ended." },
      );
    });

    fitRef.current?.fit();
    api
      .terminalOpen(sessionId, runBoxId, { cols: terminal.cols, rows: terminal.rows })
      .then((info) => {
        if (!active) {
          void api.terminalClose(sessionId);
          return;
        }
        sessionRef.current = sessionId;
        setStatus({
          kind: "connected",
          target: `${info.username}@${info.host}:${info.port}`,
        });
        terminal.focus();
      })
      .catch((error: unknown) => {
        if (!active) return;
        setStatus({
          kind: "error",
          message: ipcErrorMessage(error, "Could not open the terminal."),
        });
      });

    return () => {
      active = false;
      stop();
      if (sessionRef.current === sessionId) {
        sessionRef.current = null;
        void api.terminalClose(sessionId);
      }
    };
  }, [runBoxId, attempt]);

  const statusLabel =
    status.kind === "connecting"
      ? "Connecting…"
      : status.kind === "access"
        ? environmentAccessLabel(status.state)
      : status.kind === "connected"
        ? `Connected · ${status.target}`
        : status.kind === "closed"
          ? `Closed${status.message ? ` · ${status.message}` : ""}`
          : `Error · ${status.message}`;

  const canReconnect = status.kind === "closed" || status.kind === "error";

  return (
    <section ref={panelRef} className="terminal-panel" aria-label={`Terminal for ${title}`}>
      <div className="terminal-header">
        <div className="terminal-heading">
          <h2>{title}</h2>
          <span className="tag yellow">Trusted shell access</span>
        </div>
        <div className="terminal-actions">
          <button
            type="button"
            className="button"
            onClick={() => setAttempt((value) => value + 1)}
            disabled={!canReconnect}
          >
            Reconnect
          </button>
          <button type="button" className="button ghost" onClick={onClose}>
            Close terminal
          </button>
        </div>
      </div>
      <p
        className="terminal-status"
        role="status"
        aria-live="polite"
        data-tone={status.kind}
      >
        {statusLabel}
      </p>
      <div ref={surfaceRef} className="terminal-surface" />
    </section>
  );
}
