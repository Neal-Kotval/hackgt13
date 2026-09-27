/**
 * Parser for `codex exec --json` (Codex CLI 0.157.1) and `codex login` output
 * (HAC-122). Pure functions, no Electron imports, so node:test can drive them.
 *
 * Schema source: openai/codex tag rust-v0.157.1,
 * codex-rs/exec/src/exec_events.rs (ThreadEvent / ThreadItemDetails) and
 * codex-rs/exec/src/event_processor_with_jsonl_output.rs. Each stdout line is
 * one JSON object tagged by `type`:
 *
 *   thread.started {thread_id}      turn.started {}
 *   turn.completed {usage}          turn.failed {error:{message}}
 *   item.started|item.updated|item.completed {item:{id, type, ...}}
 *   error {message}                 (stream error; "Reconnecting... n/5" retries too)
 *
 * item.type (snake_case): agent_message {text}, reasoning {text},
 * command_execution {command, aggregated_output, exit_code, status},
 * file_change {changes:[{path, kind: add|delete|update}], status},
 * mcp_tool_call, collab_tool_call, web_search, todo_list {items}, error {message}.
 */
import type {
  CodexRunEventActor,
  CodexRunEventKind,
} from "../src/lib/codex-types.ts";

/** Contract limit for agent_run_event.text. */
export const MAX_EVENT_TEXT = 8192;
export const TRUNCATION_MARKER = "\n…[truncated]";
/** Longest JSONL line we buffer before discarding (protects the main process). */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

export type CodexItem = {
  id: string;
  type: string;
  [key: string]: unknown;
};

export type CodexThreadEvent =
  | { type: "thread.started"; thread_id: string }
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: Record<string, number> | null }
  | { type: "turn.failed"; error: { message: string } }
  | { type: "item.started" | "item.updated" | "item.completed"; item: CodexItem }
  | { type: "error"; message: string };

/** A run event before seq/at are assigned. */
export type RunEventDraft = {
  kind: CodexRunEventKind;
  actor: CodexRunEventActor;
  text?: string;
  command?: string;
  exitCode?: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function truncateText(text: string, max = MAX_EVENT_TEXT): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Parse one JSONL line. Returns null for blank lines, non-JSON noise, or
 * objects that are not a known thread event.
 */
export function parseCodexLine(line: string): CodexThreadEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (!record) return null;
  switch (record.type) {
    case "thread.started":
      return { type: "thread.started", thread_id: str(record.thread_id) };
    case "turn.started":
      return { type: "turn.started" };
    case "turn.completed": {
      const usage = asRecord(record.usage);
      const numeric: Record<string, number> = {};
      if (usage) {
        for (const [key, value] of Object.entries(usage)) {
          if (typeof value === "number") numeric[key] = value;
        }
      }
      return { type: "turn.completed", usage: usage ? numeric : null };
    }
    case "turn.failed": {
      const error = asRecord(record.error);
      return { type: "turn.failed", error: { message: str(error?.message) || "turn failed" } };
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = asRecord(record.item);
      if (!item || typeof item.type !== "string") return null;
      return {
        type: record.type,
        item: { ...item, id: str(item.id), type: item.type } as CodexItem,
      };
    }
    case "error":
      return { type: "error", message: str(record.message) || "Codex reported an error" };
    default:
      return null;
  }
}

/**
 * Splits a byte stream into complete lines. Handles chunks that cut through a
 * line or a multi-byte UTF-8 character. Overlong lines are dropped.
 */
export class LineSplitter {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");
  private dropping = false;
  droppedLines = 0;

  push(chunk: Buffer | Uint8Array | string): string[] {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (this.dropping) {
        this.dropping = false;
      } else {
        lines.push(line);
      }
      index = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = "";
      this.dropping = true;
      this.droppedLines += 1;
    }
    return lines;
  }

  /** Flush a trailing unterminated line. */
  end(): string[] {
    const tail = this.buffer + this.decoder.decode();
    this.buffer = "";
    if (this.dropping || !tail.trim()) return [];
    return [tail.replace(/\r$/, "")];
  }
}

function fileChangeText(item: CodexItem): string {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const lines = changes
    .map((change) => {
      const record = asRecord(change);
      if (!record) return null;
      const kind = str(record.kind) || "update";
      return `${kind} ${str(record.path)}`;
    })
    .filter((line): line is string => Boolean(line));
  const status = str(item.status);
  return [...lines, ...(status && status !== "completed" ? [`(${status})`] : [])].join("\n");
}

function exitCodeOf(item: CodexItem): number | null {
  return typeof item.exit_code === "number" && Number.isInteger(item.exit_code)
    ? item.exit_code
    : null;
}

function todoText(item: CodexItem): string {
  const items = Array.isArray(item.items) ? item.items : [];
  return items
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return null;
      return `${record.completed === true ? "[x]" : "[ ]"} ${str(record.text)}`;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

const RECONNECTING = /^Reconnecting\.\.\. \d+\/\d+/;

/**
 * Map one Codex thread event to zero or more contract run events. Texts are
 * truncated to the contract limit.
 */
export function mapThreadEvent(event: CodexThreadEvent): RunEventDraft[] {
  const codex = (draft: Omit<RunEventDraft, "actor">): RunEventDraft => {
    const out: RunEventDraft = { actor: "codex", ...draft };
    if (out.text !== undefined) out.text = truncateText(out.text);
    if (out.command !== undefined) out.command = truncateText(out.command, 2048);
    return out;
  };
  switch (event.type) {
    case "thread.started":
      return [codex({ kind: "status", text: "Codex thread started" })];
    case "turn.started":
      return [codex({ kind: "status", text: "Turn started" })];
    case "turn.completed": {
      const usage = event.usage;
      const tokens =
        usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number"
          ? ` · ${usage.input_tokens} input / ${usage.output_tokens} output tokens`
          : "";
      return [codex({ kind: "status", text: `Turn completed${tokens}` })];
    }
    case "turn.failed":
      return [codex({ kind: "error", text: `Turn failed: ${event.error.message}` })];
    case "error":
      // Transport retries are progress, not failures; the final error follows.
      return RECONNECTING.test(event.message)
        ? [codex({ kind: "status", text: event.message })]
        : [codex({ kind: "error", text: event.message })];
    case "item.started": {
      const item = event.item;
      if (item.type === "command_execution") {
        return [codex({ kind: "command.start", command: str(item.command) })];
      }
      if (item.type === "mcp_tool_call") {
        return [codex({ kind: "status", text: `MCP tool ${str(item.server)}.${str(item.tool)} started` })];
      }
      return [];
    }
    case "item.updated":
      return [];
    case "item.completed": {
      const item = event.item;
      switch (item.type) {
        case "agent_message":
          return [codex({ kind: "message", text: str(item.text) })];
        case "reasoning":
          return [codex({ kind: "reasoning", text: str(item.text) })];
        case "command_execution": {
          const command = str(item.command);
          const output = str(item.aggregated_output);
          const drafts: RunEventDraft[] = [];
          if (output) drafts.push(codex({ kind: "command.output", command, text: output }));
          const status = str(item.status);
          drafts.push(
            codex({
              kind: "command.exit",
              command,
              exitCode: exitCodeOf(item),
              ...(status && status !== "completed" ? { text: status } : {}),
            }),
          );
          return drafts;
        }
        case "file_change":
          return [codex({ kind: "file.change", text: fileChangeText(item) })];
        case "error":
          return [codex({ kind: "error", text: str(item.message) })];
        case "todo_list":
          return [codex({ kind: "status", text: `Plan\n${todoText(item)}` })];
        case "web_search":
          return [codex({ kind: "status", text: `Web search: ${str(item.query)}` })];
        case "mcp_tool_call": {
          const error = asRecord(item.error);
          return [
            codex({
              kind: error ? "error" : "status",
              text: `MCP tool ${str(item.server)}.${str(item.tool)} ${str(item.status) || "completed"}${
                error ? `: ${str(error.message)}` : ""
              }`,
            }),
          ];
        }
        case "collab_tool_call":
          return [codex({ kind: "status", text: `Collab tool ${str(item.tool)} ${str(item.status)}` })];
        default:
          return [];
      }
    }
    default:
      return [];
  }
}

/** Remove ANSI escape sequences (Codex colors its login prompt). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[()][A-Za-z0-9]/g, "");
}

export const DEVICE_URL_ORIGIN = "https://auth.openai.com";

/**
 * Extract the verification URL and one-time code from `codex login --device-auth`
 * stdout. Format (codex-rs/login/src/device_code_auth.rs):
 *
 *   1. Open this link in your browser and sign in to your account
 *      https://auth.openai.com/codex/device
 *   2. Enter this one-time code (expires in 15 minutes)
 *      ABCD-EFGH1
 *
 * Only an https URL on auth.openai.com is accepted.
 */
export function parseDeviceCode(text: string): { url: string; code: string } | null {
  const plain = stripAnsi(text);
  const lines = plain.split(/\r?\n/).map((line) => line.trim());
  // Streamed output: ignore a trailing partial line so a code is never cut short.
  if (!/\n$/.test(plain)) lines.pop();
  let url: string | null = null;
  let code: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!url) {
      const match = /https:\/\/[^\s]+/.exec(line);
      if (match) {
        try {
          const parsed = new URL(match[0]);
          if (parsed.origin === DEVICE_URL_ORIGIN) url = parsed.toString();
        } catch {
          // not a URL
        }
      }
    }
    if (!code && /one-time code/i.test(line)) {
      for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
        if (/^[A-Z0-9]{3,12}(?:-[A-Z0-9]{3,12})+$/.test(lines[j])) {
          code = lines[j];
          break;
        }
      }
    }
  }
  return url && code ? { url, code } : null;
}

/** `codex login` prints this on stderr after a successful sign-in. */
export const LOGIN_SUCCESS = /Successfully logged in/;

/**
 * Reduce `codex login status` output to one safe line. Known outputs:
 * "Not logged in", "Logged in using ChatGPT", "Logged in using an API key - sk-…"
 * (masked by Codex). We still redact anything key-like and cap the length.
 */
export function sanitizeStatusLine(output: string): string {
  const first =
    stripAnsi(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const redacted = first
    .replace(/\b(sk|sess|rt|eyJ)[A-Za-z0-9._-]{6,}/g, "[redacted]")
    .replace(/ - .*$/, "")
    .replace(/[A-Za-z0-9+/_-]{32,}/g, "[redacted]");
  return redacted.slice(0, 120);
}

export function interpretLoginStatus(
  exitCode: number | null,
  output: string,
): { signedIn: boolean; detail: string } {
  if (exitCode === 127 || /command not found|No such file/i.test(output)) {
    return { signedIn: false, detail: "Codex CLI is not installed in this environment." };
  }
  const detail = sanitizeStatusLine(output) || (exitCode === 0 ? "Logged in" : "Not logged in");
  const signedIn = exitCode === 0 && /^Logged in/i.test(detail);
  return { signedIn, detail };
}
