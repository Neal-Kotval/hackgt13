import { useCallback, useEffect, useRef, useState } from "react";
import "./CodexPanel.css";
import { codexApi } from "../lib/codex-api";
import {
  applyRunEvent,
  buildFollowUpPrompt,
  settleCommands,
  type PriorTurn,
  type TranscriptEntry,
} from "../lib/codex-transcript";
import type { CodexLoginStatus, CodexPanelEvent, CodexRunStatus } from "../lib/codex-types";
import { isRunEvent } from "../lib/codex-types";
import { ipcErrorMessage } from "../lib/terminal-theme";

type SignIn =
  | { kind: "checking" }
  | { kind: "signed-out"; status: CodexLoginStatus }
  | { kind: "starting" }
  | { kind: "code"; sessionId: string; url: string | null; code: string | null }
  | { kind: "copying" }
  | { kind: "signed-in"; detail: string }
  | { kind: "error"; message: string; localLoginAvailable: boolean };

type Run = {
  sessionId: string;
  runId: string | null;
  status: CodexRunStatus;
  exitCode: number | null;
  recorded: boolean;
  recordNote?: string;
  workspacePath: string;
  stopping: boolean;
  stopVerified?: boolean;
};

type CodexPanelProps = {
  runBoxId: string;
  projectId: string;
  title: string;
  onClose?: () => void;
};

function statusLine(run: Run | null): string {
  if (!run) return "Idle · each prompt runs one codex exec in the workspace";
  if (run.status === "running") return run.stopping ? "Stopping…" : `Running in ${run.workspacePath}`;
  if (run.status === "cancelled") {
    return run.stopVerified === false
      ? "Stopped · the remote process could not be confirmed gone"
      : "Stopped · remote process ended";
  }
  if (run.status === "succeeded") return "Completed";
  return `Failed${run.exitCode === null ? "" : ` · exit ${run.exitCode}`}`;
}

function exitTone(exitCode: number | null, running: boolean): string {
  if (running) return "running";
  return exitCode === 0 ? "ok" : "failed";
}

/**
 * Codex in the environment (HAC-122). Sign-in, prompt, streamed transcript,
 * Stop and Export. SSH, tokens and the Codex auth file stay in the main
 * process; this panel only sees statuses and run events.
 */
export function CodexPanel({ runBoxId, projectId, title, onClose }: CodexPanelProps) {
  const [signIn, setSignIn] = useState<SignIn>({ kind: "checking" });
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const history = useRef<PriorTurn[]>([]);
  const replyRef = useRef("");
  const pendingPrompt = useRef("");
  const sessionRef = useRef<string | null>(null);
  const loginRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLOListElement | null>(null);

  const refreshStatus = useCallback(async () => {
    setSignIn({ kind: "checking" });
    try {
      const status = await codexApi().status(runBoxId);
      setSignIn(status.signedIn ? { kind: "signed-in", detail: status.detail } : { kind: "signed-out", status });
    } catch (error) {
      setSignIn({
        kind: "error",
        message: ipcErrorMessage(error, "Could not check Codex sign-in."),
        localLoginAvailable: false,
      });
    }
  }, [runBoxId]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  // Events can arrive before the invoke that started their session resolves.
  const awaiting = useRef(false);
  const early = useRef<CodexPanelEvent[]>([]);
  const handleEventRef = useRef<(event: CodexPanelEvent) => void>(() => {});
  const knownSession = (id: string) => id === sessionRef.current || id === loginRef.current;
  const adoptSession = (kind: "run" | "login", sessionId: string) => {
    if (kind === "run") sessionRef.current = sessionId;
    else loginRef.current = sessionId;
    awaiting.current = false;
    const replay = early.current.filter((event) => event.sessionId === sessionId);
    early.current = [];
    for (const event of replay) handleEventRef.current(event);
  };

  useEffect(() => {
    const handle = (event: CodexPanelEvent) => {
      if (!knownSession(event.sessionId)) {
        if (awaiting.current && early.current.length < 500) early.current.push(event);
        return;
      }
      if (isRunEvent(event)) {
        if (event.sessionId !== sessionRef.current) return;
        if (event.kind === "message" && event.actor === "codex") replyRef.current = event.text ?? "";
        setEntries((current) => applyRunEvent(current, event));
        return;
      }
      switch (event.type) {
        case "device-code":
          if (event.sessionId !== loginRef.current) return;
          setSignIn({ kind: "code", sessionId: event.sessionId, url: event.url, code: event.code });
          return;
        case "signed-in":
          if (event.sessionId !== loginRef.current) return;
          loginRef.current = null;
          setSignIn({ kind: "signed-in", detail: event.detail });
          return;
        case "error":
          if (event.sessionId !== loginRef.current) return;
          loginRef.current = null;
          setSignIn({ kind: "error", message: event.message, localLoginAvailable: false });
          return;
        case "record-note":
          if (event.sessionId !== sessionRef.current) return;
          setRun((current) => (current ? { ...current, recorded: false, recordNote: event.note } : current));
          return;
        case "run-finished":
          if (event.sessionId !== sessionRef.current) return;
          setEntries((current) => settleCommands(current));
          history.current = [
            ...history.current,
            { prompt: pendingPrompt.current, reply: replyRef.current },
          ].slice(-6);
          setRun((current) =>
            current
              ? {
                  ...current,
                  status: event.status,
                  exitCode: event.exitCode,
                  recorded: event.recorded,
                  recordNote: event.recordNote ?? current.recordNote,
                  stopping: false,
                  stopVerified: event.stopVerified,
                }
              : current,
          );
          return;
      }
    };
    handleEventRef.current = handle;
    return codexApi().onEvent(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const list = transcriptRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [entries]);

  const startDeviceLogin = async () => {
    setSignIn({ kind: "starting" });
    awaiting.current = true;
    try {
      const { sessionId } = await codexApi().login(runBoxId);
      setSignIn({ kind: "code", sessionId, url: null, code: null });
      adoptSession("login", sessionId);
    } catch (error) {
      awaiting.current = false;
      setSignIn({
        kind: "error",
        message: ipcErrorMessage(error, "Could not start device sign-in."),
        localLoginAvailable: false,
      });
    }
  };

  const cancelDeviceLogin = async () => {
    const sessionId = loginRef.current;
    if (!sessionId) return;
    await codexApi().stop(sessionId).catch(() => undefined);
  };

  const useLocalLogin = async () => {
    setSignIn({ kind: "copying" });
    try {
      const status = await codexApi().useLocalLogin(runBoxId);
      setSignIn(status.signedIn ? { kind: "signed-in", detail: status.detail } : { kind: "signed-out", status });
    } catch (error) {
      setSignIn({
        kind: "error",
        message: ipcErrorMessage(error, "Could not copy this Mac's Codex login."),
        localLoginAvailable: true,
      });
    }
  };

  const running = run?.status === "running";
  const signedIn = signIn.kind === "signed-in";

  const submit = async () => {
    const text = prompt.trim();
    if (!text || running) return;
    setNotice(null);
    const full = buildFollowUpPrompt(history.current, text);
    pendingPrompt.current = text;
    replyRef.current = "";
    awaiting.current = true;
    try {
      const start = await codexApi().run(runBoxId, full, { projectId, recordPrompt: text });
      setRun({
        sessionId: start.sessionId,
        runId: start.runId,
        status: "running",
        exitCode: null,
        recorded: start.recorded,
        recordNote: start.recordNote,
        workspacePath: start.workspacePath,
        stopping: false,
      });
      setPrompt("");
      adoptSession("run", start.sessionId);
    } catch (error) {
      awaiting.current = false;
      early.current = [];
      setNotice({ tone: "error", text: ipcErrorMessage(error, "Could not start Codex.") });
    }
  };

  const stopRun = async () => {
    if (!run || run.status !== "running") return;
    setRun({ ...run, stopping: true });
    try {
      await codexApi().stop(run.sessionId);
    } catch (error) {
      setNotice({ tone: "error", text: ipcErrorMessage(error, "Could not stop Codex.") });
    }
  };

  const exportChanges = async () => {
    setExporting(true);
    setNotice(null);
    try {
      const result = await codexApi().exportChanges(runBoxId, { projectId });
      if (result.savedTo !== null) {
        setNotice({
          tone: "info",
          text: `Saved ${result.files} file${result.files === 1 ? "" : "s"} of changes to ${result.savedTo}`,
        });
      } else {
        setNotice({
          tone: "info",
          text: result.reason === "no-changes" ? "No changes in the workspace to export." : "Export cancelled.",
        });
      }
    } catch (error) {
      setNotice({ tone: "error", text: ipcErrorMessage(error, "Could not export changes.") });
    } finally {
      setExporting(false);
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  const localAvailable =
    (signIn.kind === "signed-out" && signIn.status.localLoginAvailable) ||
    (signIn.kind === "error" && signIn.localLoginAvailable);

  return (
    <section className="codex-panel" aria-label={`Codex for ${title}`}>
      <div className="codex-header">
        <div className="codex-heading">
          <h2>Codex · {title}</h2>
          <span className="tag yellow">Trusted shell access</span>
          <span className={`tag ${signedIn ? "green" : "cyan"}`}>
            {signIn.kind === "signed-in" ? signIn.detail : signIn.kind === "checking" ? "Checking sign-in" : "Not signed in"}
          </span>
        </div>
        <div className="codex-actions">
          <button type="button" className="button" onClick={() => void exportChanges()} disabled={exporting}>
            {exporting ? "Exporting…" : "Export changes"}
          </button>
          {onClose ? (
            <button type="button" className="button ghost" onClick={onClose}>
              Close Codex
            </button>
          ) : null}
        </div>
      </div>
      <p className="codex-lead">
        Codex runs inside this environment with its sandbox off and approvals automatic. The
        environment is the boundary; this is not a filesystem or command sandbox.
      </p>

      {!signedIn ? (
        <div className="codex-signin" role="group" aria-label="Codex sign-in">
          {signIn.kind === "checking" ? <p role="status">Checking Codex sign-in in the environment…</p> : null}
          {signIn.kind === "starting" ? <p role="status">Starting ChatGPT device sign-in…</p> : null}
          {signIn.kind === "copying" ? <p role="status">Copying this Mac's Codex login…</p> : null}
          {signIn.kind === "code" ? (
            signIn.url && signIn.code ? (
              <div className="codex-device">
                <p>
                  1. Open{" "}
                  <a
                    href={signIn.url}
                    onClick={(event) => {
                      event.preventDefault();
                      void codexApi().openDeviceUrl(signIn.sessionId);
                    }}
                  >
                    {signIn.url}
                  </a>{" "}
                  and sign in to ChatGPT.
                </p>
                <p>2. Enter this one-time code (expires in 15 minutes):</p>
                <div className="codex-code-row">
                  <code className="codex-code" aria-label="One-time code">
                    {signIn.code}
                  </code>
                  <button type="button" className="button" onClick={() => void copyCode(signIn.code ?? "")}>
                    {copied ? "Copied" : "Copy code"}
                  </button>
                </div>
                <p className="codex-muted" role="status">
                  Waiting for approval… Only continue if you started this sign-in.
                </p>
                <button type="button" className="button ghost" onClick={() => void cancelDeviceLogin()}>
                  Cancel sign-in
                </button>
              </div>
            ) : (
              <p role="status">Waiting for the sign-in code…</p>
            )
          ) : null}
          {signIn.kind === "signed-out" || signIn.kind === "error" ? (
            <>
              {signIn.kind === "error" ? (
                <p className="error-banner codex-multiline" role="alert">
                  {signIn.message}
                </p>
              ) : (
                <p>Codex is not signed in inside this environment ({signIn.status.detail}).</p>
              )}
              <div className="codex-signin-actions">
                <button type="button" className="button primary" onClick={() => void startDeviceLogin()}>
                  Sign in with ChatGPT
                </button>
                <button type="button" className="button ghost" onClick={() => void refreshStatus()}>
                  Check again
                </button>
              </div>
              <p className="codex-muted">
                Device sign-in runs <code>codex login --device-auth</code> in the environment and shows a
                link and code here. Your token stays in the environment and is removed at teardown.
              </p>
              {localAvailable ? (
                <div className="codex-local">
                  <button type="button" className="button warning" onClick={() => void useLocalLogin()}>
                    Use this Mac's Codex login
                  </button>
                  <p className="codex-muted">
                    Copies this Mac's Codex login into the environment. This may sign out Codex on this Mac;
                    the token is copied to the box and removed at teardown.
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <ol ref={transcriptRef} className="codex-transcript" role="log" aria-label="Codex transcript">
        {entries.length === 0 ? (
          <li className="codex-empty">No prompts yet in this panel.</li>
        ) : null}
        {entries.map((entry) => {
          switch (entry.type) {
            case "prompt":
              return (
                <li key={entry.id} className="codex-entry" data-kind="prompt">
                  <span className="codex-label">You</span>
                  <p className="codex-multiline">{entry.text}</p>
                </li>
              );
            case "message":
              return (
                <li key={entry.id} className="codex-entry" data-kind="message">
                  <span className="codex-label">Codex</span>
                  <p className="codex-multiline">{entry.text}</p>
                </li>
              );
            case "reasoning":
              return (
                <li key={entry.id} className="codex-entry" data-kind="reasoning">
                  <details>
                    <summary>Reasoning</summary>
                    <p className="codex-multiline">{entry.text}</p>
                  </details>
                </li>
              );
            case "command": {
              const tone = exitTone(entry.exitCode, entry.state === "running");
              return (
                <li key={entry.id} className="codex-entry" data-kind="command">
                  <details open={tone === "failed" || undefined}>
                    <summary>
                      <code className="codex-command">$ {entry.command}</code>
                      <span className="codex-exit" data-tone={tone}>
                        {entry.state === "running"
                          ? "running"
                          : entry.exitCode === null
                            ? entry.note ?? "no exit code"
                            : `exit ${entry.exitCode}`}
                      </span>
                    </summary>
                    {entry.output ? (
                      <pre className="codex-output">
                        {entry.outputTruncated ? "… earlier output omitted\n" : ""}
                        {entry.output}
                      </pre>
                    ) : (
                      <p className="codex-muted">No output.</p>
                    )}
                  </details>
                </li>
              );
            }
            case "files":
              return (
                <li key={entry.id} className="codex-entry" data-kind="files">
                  <span className="codex-label">Files changed</span>
                  <ul className="codex-files">
                    {entry.changes.map((change) => (
                      <li key={`${change.kind}:${change.path}`}>
                        <span className="codex-file-kind">{change.kind}</span> <code>{change.path}</code>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            case "error":
              return (
                <li key={entry.id} className="codex-entry" data-kind="error">
                  <p className="codex-multiline">{entry.text}</p>
                </li>
              );
            case "status":
              return (
                <li key={entry.id} className="codex-entry" data-kind="status">
                  <p className="codex-multiline">{entry.text}</p>
                </li>
              );
            default:
              return null;
          }
        })}
      </ol>

      <div className="codex-statusbar">
        <p className="codex-status" role="status" aria-live="polite" data-tone={run?.status ?? "idle"}>
          {statusLine(run)}
        </p>
        {run && !run.recorded && run.recordNote ? (
          <span className="codex-muted">{run.recordNote}</span>
        ) : null}
        {run?.runId ? (
          <button
            type="button"
            className="button ghost"
            onClick={() => void codexApi().openRunOnWeb(projectId, run.runId ?? "")}
          >
            View on web
          </button>
        ) : null}
      </div>

      {notice ? (
        <p className={notice.tone === "error" ? "error-banner" : "brand-meta"} role={notice.tone === "error" ? "alert" : "status"}>
          {notice.text}
        </p>
      ) : null}

      <form
        className="codex-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={`codex-prompt-${runBoxId}`} className="visually-hidden">
          Prompt for Codex
        </label>
        <textarea
          id={`codex-prompt-${runBoxId}`}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            history.current.length > 0 ? "Follow up… (⌘↵ to run)" : "Ask Codex to change this workspace… (⌘↵ to run)"
          }
          disabled={!signedIn}
          rows={3}
        />
        <div className="codex-composer-actions">
          {running ? (
            <button type="button" className="button danger" onClick={() => void stopRun()} disabled={run?.stopping}>
              {run?.stopping ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          <button type="submit" className="button primary" disabled={!signedIn || running || !prompt.trim()}>
            {history.current.length > 0 ? "Send follow-up" : "Run Codex"}
          </button>
        </div>
        {!signedIn ? <p className="codex-muted">Sign Codex in to this environment to send prompts.</p> : null}
      </form>
    </section>
  );
}
