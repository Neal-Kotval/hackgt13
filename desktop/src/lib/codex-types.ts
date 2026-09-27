/**
 * Shared shapes for the desktop Codex panel (HAC-122). See
 * docs/stage2-contract.md ("Desktop IPC"). Nothing here carries a token, a
 * private key, or the contents of a Codex auth file.
 */

/** Run event kinds from the Stage 2 contract (agent_run_event.kind). */
export type CodexRunEventKind =
  | "message"
  | "reasoning"
  | "command.start"
  | "command.output"
  | "command.exit"
  | "file.change"
  | "error"
  | "terminal.command"
  | "status";

export type CodexRunEventActor = "codex" | "employee";

/** One run event as recorded by POST /api/agent-runs/:id/events. */
export type CodexRunEventRecord = {
  seq: number;
  kind: CodexRunEventKind;
  actor: CodexRunEventActor;
  text?: string;
  command?: string;
  exitCode?: number | null;
  at: string;
};

/** A run event on the `codex:event` channel (contract shape). */
export type CodexRunEvent = CodexRunEventRecord & {
  sessionId: string;
  runId: string | null;
};

export type CodexRunStatus = "running" | "succeeded" | "failed" | "cancelled";

/** Non-run notifications on the `codex:event` channel. */
export type CodexControlEvent =
  | { type: "device-code"; sessionId: string; runBoxId: string; url: string; code: string }
  | { type: "signed-in"; sessionId: string; runBoxId: string; detail: string }
  | { type: "error"; sessionId: string; runBoxId: string; message: string }
  /** Recording to AgentCloud stopped mid-run; the run itself continues. */
  | { type: "record-note"; sessionId: string; runId: string | null; note: string }
  | {
      type: "run-finished";
      sessionId: string;
      runId: string | null;
      status: CodexRunStatus;
      exitCode: number | null;
      /** True when the remote process group was confirmed gone after Stop. */
      stopVerified?: boolean;
      recorded: boolean;
      recordNote?: string;
    };

export type CodexPanelEvent = CodexRunEvent | CodexControlEvent;

export function isRunEvent(event: CodexPanelEvent): event is CodexRunEvent {
  return "kind" in event;
}

export type CodexLoginStatus = {
  signedIn: boolean;
  /** Sanitized first line of `codex login status` (never a token). */
  detail: string;
  /** Whether this Mac has a local Codex login file that could be copied. */
  localLoginAvailable: boolean;
};

export type CodexRunStart = {
  sessionId: string;
  runId: string | null;
  recorded: boolean;
  recordNote?: string;
  workspacePath: string;
};

export type CodexExportResult =
  | { savedTo: string; bytes: number; files: number }
  | { savedTo: null; reason: "cancelled" | "no-changes" };

/** Renderer bridge exposed as `window.agentcloudCodex` by the preload script. */
export type CodexDesktopApi = {
  status: (runBoxId: string) => Promise<CodexLoginStatus>;
  /** ChatGPT device-code sign-in inside the environment. */
  login: (runBoxId: string) => Promise<{ sessionId: string }>;
  /** Copy this Mac's Codex login into the environment (main process only). */
  useLocalLogin: (runBoxId: string) => Promise<CodexLoginStatus>;
  run: (
    runBoxId: string,
    prompt: string,
    options: { projectId: string; recordPrompt?: string },
  ) => Promise<CodexRunStart>;
  stop: (sessionId: string) => Promise<{ stopped: boolean; verified: boolean }>;
  exportChanges: (
    runBoxId: string,
    options: { projectId: string },
  ) => Promise<CodexExportResult>;
  openDeviceUrl: (sessionId: string) => Promise<void>;
  openRunOnWeb: (projectId: string, runId: string) => Promise<void>;
  onEvent: (handler: (event: CodexPanelEvent) => void) => () => void;
};
