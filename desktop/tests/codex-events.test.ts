/**
 * Codex JSONL parser (HAC-122). Fixtures:
 * - exec-unauthenticated.jsonl: recorded from codex-cli 0.157.1 `codex exec --json`
 *   with no credentials (cf-ray / request ids redacted).
 * - exec-success.jsonl: built from the 0.157.1 schema in
 *   codex-rs/exec/src/exec_events.rs (a signed-in run was not recorded).
 * - device-auth-stdout.txt: recorded `codex login --device-auth` stdout, with
 *   the one-time code replaced by a fake one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LineSplitter,
  MAX_EVENT_TEXT,
  TRUNCATION_MARKER,
  interpretLoginStatus,
  mapThreadEvent,
  parseCodexLine,
  parseDeviceCode,
  sanitizeStatusLine,
  type RunEventDraft,
} from "../electron/codex-events.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, "fixtures/codex", name), "utf8");

function mapAll(text: string): RunEventDraft[] {
  const splitter = new LineSplitter();
  const lines = [...splitter.push(text), ...splitter.end()];
  return lines.flatMap((line) => {
    const event = parseCodexLine(line);
    return event ? mapThreadEvent(event) : [];
  });
}

describe("parseCodexLine", () => {
  it("parses every line of the recorded unauthenticated run", () => {
    const lines = fixture("exec-unauthenticated.jsonl").trim().split("\n");
    const types = lines.map((line) => parseCodexLine(line)?.type);
    assert.equal(types[0], "thread.started");
    assert.equal(types[1], "turn.started");
    assert.ok(types.every(Boolean), "every recorded line is a known event");
    assert.equal(types.at(-1), "turn.failed");
    assert.ok(types.includes("item.completed"));
    assert.ok(types.includes("error"));
  });

  it("ignores blank, non-JSON and unknown lines", () => {
    assert.equal(parseCodexLine(""), null);
    assert.equal(parseCodexLine("Reading additional input from stdin..."), null);
    assert.equal(parseCodexLine("{not json"), null);
    assert.equal(parseCodexLine('{"type":"something.new"}'), null);
    assert.equal(parseCodexLine('{"type":"item.completed","item":{"id":"x"}}'), null);
    assert.equal(parseCodexLine("[1,2]"), null);
  });
});

describe("mapThreadEvent", () => {
  it("maps the unauthenticated run to retries as status and a final error", () => {
    const events = mapAll(fixture("exec-unauthenticated.jsonl"));
    const reconnects = events.filter(
      (event) => event.kind === "status" && /^Reconnecting/.test(event.text ?? ""),
    );
    assert.equal(reconnects.length, 9);
    const errors = events.filter((event) => event.kind === "error");
    // item.completed{type:error} fallback notice, final stream error, turn.failed.
    assert.equal(errors.length, 3);
    assert.match(errors.at(-1)?.text ?? "", /^Turn failed: unexpected status 401/);
    assert.ok(events.every((event) => event.actor === "codex"));
  });

  it("maps the schema fixture to contract kinds in order", () => {
    const events = mapAll(fixture("exec-success.jsonl"));
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "status", // thread.started
        "status", // turn.started
        "reasoning",
        "command.start",
        "command.output",
        "command.exit",
        "command.start",
        "command.output",
        "command.exit",
        "file.change",
        "status", // todo_list completed
        "message",
        "status", // turn.completed
      ],
    );
    const exits = events.filter((event) => event.kind === "command.exit");
    assert.deepEqual(
      exits.map((event) => [event.command, event.exitCode, event.text]),
      [
        ["bash -lc ls", 0, undefined],
        ["bash -lc 'npm test'", 1, "failed"],
      ],
    );
    assert.equal(events.find((event) => event.kind === "file.change")?.text, "update src/greet.js\nadd src/new.js");
    assert.equal(events.find((event) => event.kind === "message")?.text, "Updated src/greet.js and added src/new.js.");
    assert.match(events.at(-1)?.text ?? "", /1200 input \/ 150 output tokens/);
  });

  it("truncates long text to the contract limit with a marker", () => {
    const [event] = mapThreadEvent({
      type: "item.completed",
      item: { id: "i", type: "agent_message", text: "x".repeat(MAX_EVENT_TEXT * 2) },
    });
    assert.equal(event.text?.length, MAX_EVENT_TEXT);
    assert.ok(event.text?.endsWith(TRUNCATION_MARKER));
  });

  it("skips started items that have no useful state", () => {
    assert.deepEqual(
      mapThreadEvent({ type: "item.started", item: { id: "i", type: "agent_message", text: "" } }),
      [],
    );
    assert.deepEqual(
      mapThreadEvent({ type: "item.updated", item: { id: "i", type: "todo_list", items: [] } }),
      [],
    );
  });
});

describe("LineSplitter", () => {
  it("reassembles lines and UTF-8 split across chunks", () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"héllo ✓"}}\n');
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += 7) out.push(...splitter.push(bytes.subarray(i, i + 7)));
    out.push(...splitter.end());
    assert.equal(out.length, 1);
    const event = parseCodexLine(out[0]);
    assert.equal(event && mapThreadEvent(event)[0].text, "héllo ✓");
  });

  it("flushes an unterminated trailing line", () => {
    const splitter = new LineSplitter();
    assert.deepEqual(splitter.push('{"type":"turn.started"}'), []);
    assert.deepEqual(splitter.end(), ['{"type":"turn.started"}']);
  });
});

describe("device auth and login status", () => {
  it("extracts the verification URL and code from recorded output", () => {
    assert.deepEqual(parseDeviceCode(fixture("device-auth-stdout.txt")), {
      url: "https://auth.openai.com/codex/device",
      code: "ABCD-EFGH1",
    });
  });

  it("returns null until both URL and code have arrived", () => {
    const text = fixture("device-auth-stdout.txt");
    assert.equal(parseDeviceCode(text.slice(0, text.indexOf("2. Enter"))), null);
  });

  it("waits for the code line to finish when output is streamed", () => {
    const text = fixture("device-auth-stdout.txt");
    const cut = text.indexOf("EFGH1") + 4;
    assert.equal(parseDeviceCode(text.slice(0, cut)), null);
  });

  it("rejects URLs that are not on auth.openai.com", () => {
    const text = fixture("device-auth-stdout.txt").replace(
      "https://auth.openai.com/codex/device",
      "https://evil.example/codex/device",
    );
    assert.equal(parseDeviceCode(text), null);
  });

  it("interprets codex login status output", () => {
    assert.deepEqual(interpretLoginStatus(1, "Not logged in\n"), {
      signedIn: false,
      detail: "Not logged in",
    });
    assert.deepEqual(interpretLoginStatus(0, "Logged in using ChatGPT\n"), {
      signedIn: true,
      detail: "Logged in using ChatGPT",
    });
    assert.equal(interpretLoginStatus(127, "bash: codex: command not found").signedIn, false);
  });

  it("never passes key material through the status line", () => {
    const detail = sanitizeStatusLine("Logged in using an API key - sk-proj-abcdefghijklmnop\n");
    assert.equal(detail, "Logged in using an API key");
    assert.doesNotMatch(sanitizeStatusLine("token eyJhbGciOiJIUzI1NiJ9.payload.sig"), /eyJ/);
  });
});
