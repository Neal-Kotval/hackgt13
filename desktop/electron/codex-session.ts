/**
 * Codex sessions inside a run box (HAC-122). Main process only; no Electron
 * imports so node:test can drive it against a real sshd container.
 *
 * - status:  `codex login status` (sanitized to one line)
 * - login:   `codex login --device-auth`, streaming the URL and one-time code
 * - useLocalLogin: copy this Mac's Codex auth file into the box over stdin
 * - run:     one `codex exec --json …` per prompt, JSONL → run events
 * - stop:    TERM/KILL the remote process group and confirm it is gone
 * - export:  `git diff` of workspacePath as a patch
 *
 * SSH trust (pinned host key, device key, connection lookup) is reused from
 * ssh-terminal.ts. Tokens, private keys and auth file contents never leave
 * this process and are never logged.
 */
import { randomUUID } from "node:crypto";
import type {
  CodexControlEvent,
  CodexLoginStatus,
  CodexPanelEvent,
  CodexRunEventRecord,
  CodexRunStart,
  CodexRunStatus,
} from "../src/lib/codex-types.ts";
import {
  LineSplitter,
  LOGIN_SUCCESS,
  interpretLoginStatus,
  mapThreadEvent,
  parseCodexLine,
  parseDeviceCode,
  stripAnsi,
  truncateText,
  type RunEventDraft,
} from "./codex-events.ts";
import {
  ENSURE_FILE_STORE_COMMAND,
  INSTALL_AUTH_COMMAND,
  LOGIN_COMMAND,
  PID_MARKER,
  STATUS_COMMAND,
  buildExportCommand,
  buildRunCommand,
  buildStopCommand,
  countPatchFiles,
} from "./codex-remote.ts";
import { RunRecorder, type HumanRequest } from "./codex-recorder.ts";
import { execCollect, execRemote, type ExecHandle, type ExecTarget } from "./codex-ssh.ts";
import { fetchRunBoxConnection } from "./ssh-terminal.ts";

export const DEVICE_AUTH_HINT =
  "If device sign-in is not enabled for your account, turn on \u201cSign in with Device Code\u201d in ChatGPT security settings, then retry.";
export const MAX_PROMPT_LENGTH = 100_000;
export const MAX_AUTH_FILE_BYTES = 256 * 1024;
export const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const RUN_BOX_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

export type CodexSessionDeps = {
  request: HumanRequest;
  privateKey: () => string;
  beforeConnect?: () => Promise<void>;
  /** True when this Mac has a Codex auth file (checked without reading it). */
  localAuthExists: () => boolean;
  /** Read this Mac's Codex auth file. Main process only. */
  readLocalAuth: () => Promise<Buffer>;
  /** Test hook: override the connection lookup. */
  resolveTarget?: (runBoxId: string) => Promise<ExecTarget>;
  exec?: typeof execRemote;
  collect?: typeof execCollect;
  now?: () => Date;
};

type Session = {
  id: string;
  ownerId: number;
  runBoxId: string;
  kind: "run" | "login";
  target: ExecTarget;
  handle: ExecHandle | null;
  pgid: number | null;
  stopping: boolean;
  stopVerified?: boolean;
  /** Settles when Stop has finished killing and checking the process group. */
  stopDone?: Promise<unknown>;
  deviceUrl: string | null;
  finished: boolean;
  stderr: string;
};

export type Send = (event: CodexPanelEvent) => void;

function assertRunBoxId(runBoxId: unknown): string {
  if (typeof runBoxId !== "string" || !RUN_BOX_ID.test(runBoxId)) {
    throw new Error("Invalid environment id.");
  }
  return runBoxId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Read `workspacePath` for one job from a GET /api/run-boxes payload. */
export function workspacePathFromListing(payload: unknown, runBoxId: string): string | null {
  const jobs = asRecord(payload)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const job = jobs.map(asRecord).find((row) => row?.id === runBoxId);
  const value = job?.workspacePath ?? job?.workspace_path;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.startsWith("/") && trimmed.length <= 1024 && !/[\u0000\n]/.test(trimmed)
    ? trimmed
    : null;
}

/** Keep only the last useful stderr line, with no ANSI and bounded length. */
function stderrSummary(stderr: string): string {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !PID_MARKER.test(line) && !/^Reading additional input/.test(line));
  return truncateText(lines.slice(-3).join("\n"), 1000);
}

export class CodexSessions {
  private readonly sessions = new Map<string, Session>();
  /** Device-code links by login session, kept after the login process ends. */
  private readonly deviceUrls = new Map<string, { ownerId: number; url: string }>();
  private readonly deps: CodexSessionDeps;

  constructor(deps: CodexSessionDeps) {
    this.deps = deps;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private async target(runBoxId: string): Promise<ExecTarget> {
    if (this.deps.resolveTarget) return this.deps.resolveTarget(runBoxId);
    await this.deps.beforeConnect?.();
    const connection = await fetchRunBoxConnection(this.deps.request, runBoxId);
    return {
      host: connection.host,
      port: connection.port,
      username: connection.username,
      hostPublicKey: connection.hostPublicKey,
      privateKey: this.deps.privateKey(),
    };
  }

  private collect(): typeof execCollect {
    return this.deps.collect ?? execCollect;
  }

  async workspacePath(projectId: string, runBoxId: string): Promise<string | null> {
    if (typeof projectId !== "string" || !PROJECT_ID.test(projectId)) {
      throw new Error("Invalid project id.");
    }
    try {
      const response = await this.deps.request(
        `/api/run-boxes?projectId=${encodeURIComponent(projectId)}`,
        { method: "GET" },
      );
      if (!response.ok) return null;
      return workspacePathFromListing(JSON.parse(await response.text()), runBoxId);
    } catch {
      return null;
    }
  }

  async status(runBoxId: string): Promise<CodexLoginStatus> {
    assertRunBoxId(runBoxId);
    const target = await this.target(runBoxId);
    const result = await this.collect()(target, STATUS_COMMAND, {
      maxBytes: 16 * 1024,
      timeoutMs: 20_000,
    });
    const { signedIn, detail } = interpretLoginStatus(
      result.exitCode,
      `${result.stdout}\n${result.stderr}`,
    );
    return { signedIn, detail, localLoginAvailable: this.localLoginAvailable() };
  }

  /** Force file-based credential storage so teardown cleanup removes the token. */
  private async ensureFileStore(target: ExecTarget): Promise<void> {
    const result = await this.collect()(target, ENSURE_FILE_STORE_COMMAND, {
      maxBytes: 4096,
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      throw new Error("Could not configure Codex file-based credential storage in the environment.");
    }
  }

  localLoginAvailable(): boolean {
    try {
      return this.deps.localAuthExists();
    } catch {
      return false;
    }
  }

  /**
   * Copy this Mac's Codex auth file into the environment as the SSH user,
   * owner-only, via stdin. Returns only the sanitized remote login status.
   */
  async useLocalLogin(runBoxId: string): Promise<CodexLoginStatus> {
    assertRunBoxId(runBoxId);
    if (!this.localLoginAvailable()) {
      throw new Error("This Mac has no Codex login. Run `codex login` locally or use device sign-in.");
    }
    const target = await this.target(runBoxId);
    await this.ensureFileStore(target);
    let content: Buffer | null = null;
    try {
      content = await this.deps.readLocalAuth();
      if (content.length === 0 || content.length > MAX_AUTH_FILE_BYTES) {
        throw new Error("This Mac's Codex login file is empty or too large to copy.");
      }
      try {
        const parsed: unknown = JSON.parse(content.toString("utf8"));
        if (!asRecord(parsed)) throw new Error("not an object");
      } catch {
        throw new Error("This Mac's Codex login file is not valid JSON.");
      }
      const result = await this.collect()(target, INSTALL_AUTH_COMMAND, {
        stdin: content,
        maxBytes: 4096,
        timeoutMs: 20_000,
      });
      if (result.exitCode !== 0) {
        throw new Error("Could not write the Codex login into the environment.");
      }
    } finally {
      content?.fill(0);
    }
    return this.status(runBoxId);
  }

  private register(session: Session): void {
    this.sessions.set(session.id, session);
  }

  private captureStderr(session: Session, chunk: Buffer): void {
    if (session.stderr.length < 64 * 1024) session.stderr += chunk.toString("utf8");
    if (session.pgid === null) {
      const match = PID_MARKER.exec(session.stderr);
      if (match) session.pgid = Number(match[2]);
    }
  }

  async login(ownerId: number, send: Send, runBoxId: string): Promise<{ sessionId: string }> {
    assertRunBoxId(runBoxId);
    const target = await this.target(runBoxId);
    await this.ensureFileStore(target);
    const session: Session = {
      id: randomUUID(),
      ownerId,
      runBoxId,
      kind: "login",
      target,
      handle: null,
      pgid: null,
      stopping: false,
      deviceUrl: null,
      finished: false,
      stderr: "",
    };
    this.register(session);
    let stdout = "";
    let announced = false;
    const control = (event: CodexControlEvent) => send(event);
    try {
      session.handle = await (this.deps.exec ?? execRemote)(target, LOGIN_COMMAND, {
        onStdout: (chunk) => {
          if (stdout.length < 16 * 1024) stdout += chunk.toString("utf8");
          if (announced) return;
          const parsed = parseDeviceCode(stdout);
          if (!parsed) return;
          announced = true;
          session.deviceUrl = parsed.url;
          this.deviceUrls.set(session.id, { ownerId, url: parsed.url });
          control({ type: "device-code", sessionId: session.id, runBoxId, ...parsed });
        },
        onStderr: (chunk) => this.captureStderr(session, chunk),
      });
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    void session.handle.done.then(async ({ exitCode }) => {
      if (session.stopDone) await session.stopDone;
      session.finished = true;
      const success = exitCode === 0 && LOGIN_SUCCESS.test(session.stderr);
      try {
        if (session.stopping) {
          control({ type: "error", sessionId: session.id, runBoxId, message: "Sign-in cancelled." });
        } else if (success || exitCode === 0) {
          const status = await this.status(runBoxId).catch(() => null);
          control({
            type: "signed-in",
            sessionId: session.id,
            runBoxId,
            detail: status?.detail ?? "Logged in",
          });
        } else {
          control({
            type: "error",
            sessionId: session.id,
            runBoxId,
            message:
              exitCode === 127
                ? "Codex CLI is not installed in this environment."
                : `${stderrSummary(session.stderr) || `Sign-in ended (exit ${exitCode ?? "unknown"}).`}\n${DEVICE_AUTH_HINT}`,
          });
        }
      } finally {
        this.sessions.delete(session.id);
      }
    });
    return { sessionId: session.id };
  }

  deviceUrl(ownerId: number, sessionId: string): string | null {
    const entry = this.deviceUrls.get(sessionId);
    return entry && entry.ownerId === ownerId ? entry.url : null;
  }

  async run(
    ownerId: number,
    send: Send,
    runBoxId: string,
    prompt: string,
    options: { projectId: string; recordPrompt?: string },
  ): Promise<CodexRunStart> {
    assertRunBoxId(runBoxId);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Enter a prompt for Codex.");
    if (prompt.length > MAX_PROMPT_LENGTH) throw new Error("Prompt is too long.");
    const recordPrompt =
      typeof options?.recordPrompt === "string" && options.recordPrompt.trim()
        ? options.recordPrompt
        : prompt;
    const [target, workspacePath] = await Promise.all([
      this.target(runBoxId),
      this.workspacePath(options?.projectId, runBoxId),
    ]);

    const sessionId = randomUUID();
    const recorder = new RunRecorder({
      request: this.deps.request,
      onUnrecorded: (note) => {
        send({ type: "record-note", sessionId, runId: recorder.runId, note });
      },
    });
    await recorder.start(runBoxId, recordPrompt);
    const runId = recorder.runId;

    const session: Session = {
      id: sessionId,
      ownerId,
      runBoxId,
      kind: "run",
      target,
      handle: null,
      pgid: null,
      stopping: false,
      deviceUrl: null,
      finished: false,
      stderr: "",
    };
    this.register(session);

    let seq = 0;
    let turnFailed = false;
    let sawEvent = false;
    const emit = (draft: RunEventDraft) => {
      seq += 1;
      const record: CodexRunEventRecord = { seq, ...draft, at: this.now() };
      recorder.push(record);
      send({ ...record, sessionId, runId });
    };
    const splitter = new LineSplitter();
    const handleLines = (lines: string[]) => {
      for (const line of lines) {
        const event = parseCodexLine(line);
        if (!event) continue;
        sawEvent = true;
        if (event.type === "turn.failed") turnFailed = true;
        for (const draft of mapThreadEvent(event)) emit(draft);
      }
    };

    emit({ kind: "message", actor: "employee", text: truncateText(recordPrompt) });
    emit({
      kind: "status",
      actor: "codex",
      text: `Starting Codex in ${workspacePath ?? "~ (workspace path not reported)"}`,
    });

    try {
      session.handle = await (this.deps.exec ?? execRemote)(
        target,
        buildRunCommand(workspacePath, prompt),
        {
          onStdout: (chunk) => handleLines(splitter.push(chunk)),
          onStderr: (chunk) => this.captureStderr(session, chunk),
        },
      );
    } catch (error) {
      this.sessions.delete(sessionId);
      const message = error instanceof Error ? error.message : "Could not start Codex.";
      emit({ kind: "error", actor: "codex", text: message });
      await recorder.finish("failed", null);
      send({
        type: "run-finished",
        sessionId,
        runId,
        status: "failed",
        exitCode: null,
        recorded: recorder.recorded,
        ...(recorder.note ? { recordNote: recorder.note } : {}),
      });
      throw error;
    }

    void session.handle.done.then(async ({ exitCode }) => {
      handleLines(splitter.end());
      // The channel usually closes while Stop is still confirming the kill.
      if (session.stopDone) await session.stopDone;
      session.finished = true;
      let status: CodexRunStatus;
      if (session.stopping) {
        status = "cancelled";
        emit({
          kind: "status",
          actor: "employee",
          text: session.stopVerified === false ? "Stopped (remote process not confirmed gone)" : "Stopped",
        });
      } else if (exitCode === 0 && !turnFailed) {
        status = "succeeded";
      } else {
        status = "failed";
        if (exitCode === 127) {
          emit({ kind: "error", actor: "codex", text: "Codex CLI is not installed in this environment." });
        } else if (!sawEvent) {
          const detail = stderrSummary(session.stderr);
          emit({
            kind: "error",
            actor: "codex",
            text: detail || `Codex exited with code ${exitCode ?? "unknown"}.`,
          });
        }
      }
      emit({
        kind: "status",
        actor: "codex",
        text: `Codex exited${exitCode === null ? "" : ` with code ${exitCode}`} · ${status}`,
      });
      try {
        await recorder.finish(status, exitCode);
      } finally {
        this.sessions.delete(sessionId);
        send({
          type: "run-finished",
          sessionId,
          runId,
          status,
          exitCode,
          ...(session.stopping ? { stopVerified: session.stopVerified === true } : {}),
          recorded: recorder.recorded,
          ...(recorder.note ? { recordNote: recorder.note } : {}),
        });
      }
    });

    return {
      sessionId,
      runId,
      recorded: recorder.recorded,
      ...(recorder.note ? { recordNote: recorder.note } : {}),
      workspacePath: workspacePath ?? "~",
    };
  }

  /**
   * Kill the remote process group (TERM, then KILL) over a separate exec
   * channel, confirm nothing in the group survives, then close the channel.
   */
  async stop(ownerId: number, sessionId: string): Promise<{ stopped: boolean; verified: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { stopped: false, verified: false };
    return this.stopSession(session);
  }

  private stopSession(session: Session): Promise<{ stopped: boolean; verified: boolean }> {
    if (session.finished) return Promise.resolve({ stopped: false, verified: true });
    if (session.stopDone) {
      return session.stopDone.then(() => ({ stopped: true, verified: session.stopVerified === true }));
    }
    const done = this.killSession(session);
    session.stopDone = done.catch(() => undefined);
    return done;
  }

  private async killSession(session: Session): Promise<{ stopped: boolean; verified: boolean }> {
    session.stopping = true;
    let verified = false;
    if (session.pgid !== null) {
      try {
        const result = await this.collect()(session.target, buildStopCommand(session.pgid), {
          maxBytes: 1024,
          timeoutMs: 15_000,
        });
        verified = /\bGONE\b/.test(result.stdout);
      } catch {
        verified = false;
      }
    } else {
      session.handle?.signal("TERM");
    }
    session.stopVerified = verified;
    session.handle?.close();
    return { stopped: true, verified };
  }

  async exportPatch(
    runBoxId: string,
    projectId: string,
  ): Promise<{ patch: string; files: number; workspacePath: string }> {
    assertRunBoxId(runBoxId);
    const [target, workspacePath] = await Promise.all([
      this.target(runBoxId),
      this.workspacePath(projectId, runBoxId),
    ]);
    const result = await this.collect()(target, buildExportCommand(workspacePath), {
      maxBytes: MAX_PATCH_BYTES,
      timeoutMs: 60_000,
    });
    if (/AGENTCLOUD_EXPORT_ERROR=not-git/.test(result.stderr)) {
      throw new Error(`${workspacePath ?? "The home directory"} is not a Git repository.`);
    }
    if (/AGENTCLOUD_EXPORT_ERROR=workspace/.test(result.stderr)) {
      throw new Error("The workspace directory does not exist in this environment.");
    }
    if (result.truncated) throw new Error("The patch is larger than 20 MB; export it from the terminal.");
    if (result.exitCode !== 0) {
      throw new Error(stderrSummary(result.stderr) || `git diff failed (exit ${result.exitCode}).`);
    }
    return {
      patch: result.stdout,
      files: countPatchFiles(result.stdout),
      workspacePath: workspacePath ?? "~",
    };
  }

  closeOwner(ownerId: number): void {
    for (const [id, entry] of this.deviceUrls) {
      if (entry.ownerId === ownerId) this.deviceUrls.delete(id);
    }
    for (const session of this.sessions.values()) {
      if (session.ownerId === ownerId) void this.stopSession(session);
    }
  }

  closeAll(): Promise<unknown> {
    return Promise.allSettled([...this.sessions.values()].map((session) => this.stopSession(session)));
  }

  get size(): number {
    return this.sessions.size;
  }
}
