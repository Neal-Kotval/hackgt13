import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_COMMAND_OUTPUT,
  applyRunEvent,
  buildFollowUpPrompt,
  settleCommands,
  type TranscriptEntry,
} from "../src/lib/codex-transcript.ts";
import type { CodexRunEvent } from "../src/lib/codex-types.ts";

let seq = 0;
const ev = (partial: Partial<CodexRunEvent> & Pick<CodexRunEvent, "kind">): CodexRunEvent => ({
  sessionId: "s",
  runId: null,
  seq: ++seq,
  actor: "codex",
  at: "2026-01-01T00:00:00.000Z",
  ...partial,
});

function fold(events: CodexRunEvent[]): TranscriptEntry[] {
  return events.reduce(applyRunEvent, [] as TranscriptEntry[]);
}

describe("codex transcript", () => {
  it("builds prompt, reasoning, command, files and message entries", () => {
    const entries = fold([
      ev({ kind: "message", actor: "employee", text: "fix it" }),
      ev({ kind: "reasoning", text: "thinking" }),
      ev({ kind: "command.start", command: "ls" }),
      ev({ kind: "command.output", command: "ls", text: "a\nb\n" }),
      ev({ kind: "command.exit", command: "ls", exitCode: 0 }),
      ev({ kind: "file.change", text: "update src/a.ts\nadd src/b.ts" }),
      ev({ kind: "message", text: "done" }),
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.type),
      ["prompt", "reasoning", "command", "files", "message"],
    );
    const command = entries[2];
    assert.ok(command.type === "command");
    assert.deepEqual([command.output, command.exitCode, command.state], ["a\nb\n", 0, "done"]);
    const files = entries[3];
    assert.ok(files.type === "files");
    assert.deepEqual(files.changes, [
      { kind: "update", path: "src/a.ts" },
      { kind: "add", path: "src/b.ts" },
    ]);
  });

  it("bounds command output and keeps the tail", () => {
    const entries = fold([
      ev({ kind: "command.start", command: "yes" }),
      ev({ kind: "command.output", command: "yes", text: "x".repeat(MAX_COMMAND_OUTPUT) + "END" }),
    ]);
    const command = entries[0];
    assert.ok(command.type === "command");
    assert.equal(command.output.length, MAX_COMMAND_OUTPUT);
    assert.ok(command.output.endsWith("END"));
    assert.equal(command.outputTruncated, true);
  });

  it("settles commands still running when the run ends", () => {
    const settled = settleCommands(fold([ev({ kind: "command.start", command: "sleep 300" })]));
    assert.ok(settled[0].type === "command" && settled[0].state === "done");
  });

  it("builds bounded follow-up prompts", () => {
    assert.equal(buildFollowUpPrompt([], "hi"), "hi");
    const follow = buildFollowUpPrompt([{ prompt: "add tests", reply: "Added 3 tests." }], "now run them");
    assert.match(follow, /Earlier prompt: add tests\nCodex replied: Added 3 tests\./);
    assert.ok(follow.endsWith("Follow-up: now run them"));
    const long = buildFollowUpPrompt(
      Array.from({ length: 20 }, (_, i) => ({ prompt: `p${i} ${"x".repeat(2000)}`, reply: "y".repeat(2000) })),
      "next",
    );
    assert.ok(long.length < 8000);
    assert.match(long, /p19/);
  });
});
