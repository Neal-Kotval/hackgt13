/**
 * Transcript model for the Codex panel (HAC-122). Pure; folds `codex:event`
 * run events into display entries and builds follow-up prompts.
 */
import type { CodexRunEvent } from "./codex-types";

/** Output kept per command in the UI (the recorded event is already ≤ 8 KB). */
export const MAX_COMMAND_OUTPUT = 4000;

export type TranscriptEntry =
  | { id: string; type: "prompt"; text: string }
  | { id: string; type: "message"; text: string }
  | { id: string; type: "reasoning"; text: string }
  | {
      id: string;
      type: "command";
      command: string;
      output: string;
      outputTruncated: boolean;
      exitCode: number | null;
      state: "running" | "done";
      note?: string;
    }
  | { id: string; type: "files"; changes: { kind: string; path: string }[] }
  | { id: string; type: "error"; text: string }
  | { id: string; type: "status"; text: string };

function bound(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_COMMAND_OUTPUT) return { text, truncated: false };
  return { text: text.slice(-MAX_COMMAND_OUTPUT), truncated: true };
}

function findRunningCommand(entries: TranscriptEntry[], command: string | undefined): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.type === "command" && entry.state === "running" && (!command || entry.command === command)) {
      return i;
    }
  }
  return -1;
}

export function parseFileChanges(text: string): { kind: string; path: string }[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("("))
    .map((line) => {
      const space = line.indexOf(" ");
      return space > 0
        ? { kind: line.slice(0, space), path: line.slice(space + 1) }
        : { kind: "update", path: line };
    });
}

/** Fold one run event into the transcript (returns a new array). */
export function applyRunEvent(entries: TranscriptEntry[], event: CodexRunEvent): TranscriptEntry[] {
  const id = `${event.sessionId}:${event.seq}`;
  const text = event.text ?? "";
  switch (event.kind) {
    case "message":
      return [...entries, event.actor === "employee" ? { id, type: "prompt", text } : { id, type: "message", text }];
    case "reasoning":
      return [...entries, { id, type: "reasoning", text }];
    case "command.start":
      return [
        ...entries,
        {
          id,
          type: "command",
          command: event.command ?? "",
          output: "",
          outputTruncated: false,
          exitCode: null,
          state: "running",
        },
      ];
    case "command.output":
    case "command.exit": {
      const next = [...entries];
      let index = findRunningCommand(next, event.command);
      if (index === -1) {
        next.push({
          id,
          type: "command",
          command: event.command ?? "",
          output: "",
          outputTruncated: false,
          exitCode: null,
          state: "running",
        });
        index = next.length - 1;
      }
      const current = next[index];
      if (current.type !== "command") return next;
      if (event.kind === "command.output") {
        const out = bound(current.output + text);
        next[index] = { ...current, output: out.text, outputTruncated: current.outputTruncated || out.truncated };
      } else {
        next[index] = {
          ...current,
          exitCode: typeof event.exitCode === "number" ? event.exitCode : null,
          state: "done",
          ...(text ? { note: text } : {}),
        };
      }
      return next;
    }
    case "file.change":
      return [...entries, { id, type: "files", changes: parseFileChanges(text) }];
    case "error":
      return [...entries, { id, type: "error", text }];
    case "status":
    case "terminal.command":
      return [...entries, { id, type: "status", text: event.kind === "terminal.command" ? `$ ${text}` : text }];
    default:
      return entries;
  }
}

/** Mark any still-running commands as ended when the run finishes. */
export function settleCommands(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) =>
    entry.type === "command" && entry.state === "running"
      ? { ...entry, state: "done", note: entry.note ?? "ended with the run" }
      : entry,
  );
}

export type PriorTurn = { prompt: string; reply: string };

const CONTEXT_BUDGET = 6000;
const PER_TURN = 1500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Each prompt is its own ephemeral `codex exec`, so a follow-up carries a
 * bounded summary of earlier prompts and replies. Workspace files persist
 * between runs on their own.
 */
export function buildFollowUpPrompt(history: PriorTurn[], next: string): string {
  if (history.length === 0) return next;
  const turns: string[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = `Earlier prompt: ${clip(history[i].prompt, PER_TURN)}\nCodex replied: ${clip(
      history[i].reply || "(no reply)",
      PER_TURN,
    )}`;
    if (used + turn.length > CONTEXT_BUDGET) break;
    turns.unshift(turn);
    used += turn.length;
  }
  if (turns.length === 0) return next;
  return [
    "Context from earlier prompts in this environment. Each ran as a separate Codex session; files in the workspace persist.",
    ...turns,
    "---",
    `Follow-up: ${next}`,
  ].join("\n\n");
}
