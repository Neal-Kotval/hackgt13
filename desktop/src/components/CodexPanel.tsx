import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./CodexPanel.css";
import { Composer, type ChatAttachment } from "./Composer";
import { CodexConversation, type CodexEvent } from "./CodexConversation";
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
  chat: { context: ReactNode; ready: boolean; onBusy: (busy: boolean) => void; onTitle: (title: string) => void };

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

/**
 * Codex in the environment (HAC-122). Sign-in, prompt, streamed transcript,
 * Stop and Export. SSH, tokens and the Codex auth file stay in the main
 * process; this panel only sees statuses and run events.
 */
export function CodexPanel({ runBoxId, projectId, title, chat }: CodexPanelProps) {
  const [signIn, setSignIn] = useState<SignIn>({ kind: "checking" });
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [prompt, setPrompt] = useState("");
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [copied, setCopied] = useState(false);
  const history = useRef<PriorTurn[]>([]);
  const replyRef = useRef("");
  const pendingPrompt = useRef("");
  const sessionRef = useRef<string | null>(null);
  const loginRef = useRef<string | null>(null);

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

  const startDeviceLogin = async () => {
    if (chat && !chat.ready) return;
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
    try {
      await codexApi().stop(sessionId);
      loginRef.current = null;
      await refreshStatus();
    } catch (error) {
      setNotice({ tone: "error", text: ipcErrorMessage(error, "Could not cancel sign-in.") });
    }
  };

  const useLocalLogin = async () => {
    if (chat && !chat.ready) return;
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

  const active = submitting || Boolean(running) || ["starting", "code", "copying"].includes(signIn.kind);
  const busyCallback = useRef(chat?.onBusy);
  busyCallback.current = chat?.onBusy;
  useEffect(() => { busyCallback.current?.(active); }, [active]);
  const submit = async () => {
    const text = [prompt.trim(), ...attachments.map(file => `Attached context: ${file.name}\n${file.text}`)].filter(Boolean).join("\n\n");
    if (!text || running || submitting || !signedIn || (chat && !chat.ready)) return;
    if (text.length > 16000) {
      setNotice({ tone: "error", text: "Keep the message and attachments within 16,000 characters." });
      return;
    }
    setSubmitting(true);
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
      setAttachments([]);
      chat?.onTitle(text.split("\n")[0]);
      adoptSession("run", start.sessionId);
    } catch (error) {
      awaiting.current = false;
      early.current = [];
      setNotice({ tone: "error", text: ipcErrorMessage(error, "Could not start Codex.") });
    } finally { setSubmitting(false); }
  };

  const stopRun = async () => {
    if (!run || run.status !== "running" || run.stopping) return;
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

  async function attachFiles(files: File[]) {
    try {
      if (files.length + attachments.length > 8) throw new Error("Attach up to 8 text files per message.");
      const added = await Promise.all(files.map(async file => {
        if (file.size > 16000) throw new Error(`${file.name} exceeds 16 KB.`);
        const text = await file.text();
        if (text.includes("\0") || (!file.type.startsWith("text/") && !/\.(md|txt|json|[cm]?js|jsx|tsx?|py|css|html|csv|ya?ml|toml|sh|sql|log)$/i.test(file.name))) throw new Error(`${file.name} is not a supported text file.`);
        return { id: crypto.randomUUID(), name: file.name, text };
      }));
      setAttachments(current => [...current, ...added]);
    } catch (error) { setNotice({ tone: "error", text: ipcErrorMessage(error, "Could not read attachment.") }); }
  }

      const signInContent = !signedIn ? (
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
      ) : null;
  {
    const events: CodexEvent[] = entries.map(entry => {
      const base = { id: entry.id, updatedAt: "" };
      switch (entry.type) {
        case "prompt": return { ...base, kind: "user", text: entry.text };
        case "message": return { ...base, kind: "assistant", text: entry.text };
        case "command": return { ...base, kind: "command", text: entry.command, parts: [{ type: "tool", steps: [{ cmd: entry.command, result: entry.output, ...(entry.state === "done" && entry.exitCode !== null ? { ok: entry.exitCode === 0 } : {}) }], status: entry.state === "running" ? "running" : entry.exitCode === 0 ? "done" : "failed", outputTail: entry.note }] };
        case "files": return { ...base, kind: "assistant", text: "", parts: [{ type: "files", files: entry.changes.map(file => ({ path: file.path })) }] };
        case "error": return { ...base, kind: "error", text: entry.text };
        default: return { ...base, kind: "status", text: entry.text };
      }
    });
    return <>
      <CodexConversation events={events} working={Boolean(running)} agentName="Codex" environmentName={title} emptyContent={<p>Send instructions to Codex in this environment.</p>} />
      <div className="chat-compose-area">
        {signInContent}
        {!chat.ready && <p className="credential-banner" role="status">This environment is not ready. Reconnect it from Environments before sending a message.</p>}
        <div className="project-chat-recovery">
          <span role="status">{run ? statusLine(run) : signedIn ? "Ready · Trusted shell access" : "Sign in to this environment to chat"}</span>
          {run && !run.recorded && run.recordNote && <span>{run.recordNote}</span>}
          <button type="button" className="button ghost" onClick={() => void exportChanges()} disabled={exporting || active || !chat.ready}>{exporting ? "Exporting…" : "Export changes"}</button>
          {run?.runId && <button type="button" className="button ghost" onClick={() => void codexApi().openRunOnWeb(projectId, run.runId ?? "")}>View run</button>}
        </div>
        <Composer value={prompt} disabled={submitting} sendDisabled={!signedIn || !chat.ready} sending={Boolean(running)} error={notice?.tone === "error" ? notice.text : null} context={chat.context} attachments={attachments} onAttach={files => void attachFiles(files)} onRemoveAttachment={id => setAttachments(current => current.filter(file => file.id !== id))} onChange={setPrompt} onSend={() => void submit()} onStop={() => void stopRun()} />
        {notice?.tone === "info" && <p className="brand-meta" role="status">{notice.text}</p>}
      </div>
    </>;
  }

}
