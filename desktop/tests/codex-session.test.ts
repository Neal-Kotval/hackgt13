/**
 * CodexSessions and RunRecorder with stubbed SSH (HAC-122): event recording,
 * 404 tolerance, stop, and that this Mac's Codex auth file never leaves the
 * main process except as stdin to the box.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodexBridge } from "../electron/codex-preload.ts";
import { RunRecorder } from "../electron/codex-recorder.ts";
import { CodexSessions, workspacePathFromListing } from "../electron/codex-session.ts";
import type { ExecHandle, ExecHandlers, ExecTarget } from "../electron/codex-ssh.ts";
import type { CodexPanelEvent } from "../src/lib/codex-types.ts";
import { ENSURE_FILE_STORE_COMMAND, INSTALL_AUTH_COMMAND, STATUS_COMMAND } from "../electron/codex-remote.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const SUCCESS = readFileSync(path.join(here, "fixtures/codex/exec-success.jsonl"), "utf8");
const TARGET: ExecTarget = {
  host: "127.0.0.1",
  port: 22,
  username: "agentcloud",
  hostPublicKey: "ssh-ed25519 AAAA",
  privateKey: "PRIVATE",
};
const SECRET = '{"tokens":{"access_token":"SECRET-ACCESS-abc123","refresh_token":"SECRET-REFRESH"}}';

type Call = { method: string; path: string; body?: unknown };

function fakeApi(routes: { runs?: number; events?: number } = {}) {
  const calls: Call[] = [];
  const request = async (p: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path: p, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (p.startsWith("/api/run-boxes?")) {
      return new Response(JSON.stringify({ jobs: [{ id: "rb1", workspacePath: "/home/agentcloud/workspace/repo" }] }));
    }
    if (p === "/api/agent-runs") {
      const status = routes.runs ?? 201;
      return new Response(status === 201 ? JSON.stringify({ run: { id: "run-1" } }) : "{}", { status });
    }
    if (p.endsWith("/events")) {
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), { status: routes.events ?? 200 });
    }
    if (p.endsWith("/finish")) return new Response(JSON.stringify({ run: {} }));
    return new Response("{}", { status: 404 });
  };
  return { calls, request };
}

/** Exec stub that replays stdout chunks, then exits (or waits to be stopped). */
function fakeExec(script: { stdout?: string; stderr?: string; exitCode?: number; hang?: boolean }) {
  const commands: string[] = [];
  let closeIt: (() => void) | null = null;
  const exec = async (_t: ExecTarget, command: string, handlers: ExecHandlers = {}): Promise<ExecHandle> => {
    commands.push(command);
    let resolveDone: (v: { exitCode: number | null; signal: string | null }) => void = () => {};
    const done = new Promise<{ exitCode: number | null; signal: string | null }>((r) => {
      resolveDone = r;
    });
    closeIt = () => resolveDone({ exitCode: null, signal: null });
    setImmediate(() => {
      if (script.stderr) handlers.onStderr?.(Buffer.from(script.stderr));
      for (let i = 0; i < (script.stdout ?? "").length; i += 50) {
        handlers.onStdout?.(Buffer.from((script.stdout ?? "").slice(i, i + 50)));
      }
      if (!script.hang) resolveDone({ exitCode: script.exitCode ?? 0, signal: null });
    });
    return { done, close: () => closeIt?.(), signal: () => {} };
  };
  return { exec, commands };
}

function collector() {
  const collected: { command: string; stdin?: string }[] = [];
  const collect = async (_t: ExecTarget, command: string, options: { stdin?: Buffer | string } = {}) => {
    collected.push({ command, stdin: options.stdin?.toString() });
    if (command === STATUS_COMMAND) {
      return { exitCode: 0, stdout: "Logged in using ChatGPT\n", stderr: "", truncated: false };
    }
    if (command.includes("kill -TERM")) return { exitCode: 0, stdout: "GONE\n", stderr: "", truncated: false };
    return { exitCode: 0, stdout: "", stderr: "", truncated: false };
  };
  return { collect, collected };
}

function sessions(opts: { api?: ReturnType<typeof fakeApi>; exec?: ReturnType<typeof fakeExec>["exec"]; collect?: ReturnType<typeof collector>["collect"]; hasLocal?: boolean } = {}) {
  const api = opts.api ?? fakeApi();
  return new CodexSessions({
    request: api.request,
    privateKey: () => "PRIVATE",
    localAuthExists: () => opts.hasLocal ?? true,
    readLocalAuth: async () => Buffer.from(SECRET),
    resolveTarget: async () => TARGET,
    exec: opts.exec,
    collect: opts.collect as never,
  });
}

function waitFor<T>(events: T[], predicate: (e: T) => boolean, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const found = events.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - start > ms) return reject(new Error("timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("workspacePathFromListing", () => {
  it("reads an absolute workspacePath and rejects others", () => {
    assert.equal(workspacePathFromListing({ jobs: [{ id: "a", workspacePath: "/w" }] }, "a"), "/w");
    assert.equal(workspacePathFromListing({ jobs: [{ id: "a", workspacePath: null }] }, "a"), null);
    assert.equal(workspacePathFromListing({ jobs: [{ id: "a", workspacePath: "rel" }] }, "a"), null);
    assert.equal(workspacePathFromListing({ jobs: [{ id: "b", workspacePath: "/w" }] }, "a"), null);
  });
});

describe("CodexSessions.run", () => {
  it("streams events with increasing seq and records them", async () => {
    const api = fakeApi();
    const { exec, commands } = fakeExec({ stdout: SUCCESS, stderr: "AGENTCLOUD_PID=77 AGENTCLOUD_PGID=77\n" });
    const events: CodexPanelEvent[] = [];
    const s = sessions({ api, exec });
    const start = await s.run(1, (e) => events.push(e), "rb1", "fix it", { projectId: "p1" });
    assert.equal(start.runId, "run-1");
    assert.equal(start.recorded, true);
    assert.equal(start.workspacePath, "/home/agentcloud/workspace/repo");
    assert.match(commands[0], /'\/home\/agentcloud\/workspace\/repo' 'fix it'$/);
    const finished = await waitFor(events, (e) => "type" in e && e.type === "run-finished");
    assert.deepEqual(
      { status: (finished as { status: string }).status, recorded: (finished as { recorded: boolean }).recorded },
      { status: "succeeded", recorded: true },
    );
    const runEvents = events.filter((e) => "kind" in e) as Array<{ seq: number; kind: string; actor: string }>;
    assert.deepEqual(runEvents.map((e) => e.seq), runEvents.map((_, i) => i + 1));
    assert.equal(runEvents[0].actor, "employee");
    const posted = api.calls
      .filter((c) => c.path === "/api/agent-runs/run-1/events")
      .flatMap((c) => (c.body as { events: { seq: number }[] }).events.map((e) => e.seq));
    assert.deepEqual(posted, runEvents.map((e) => e.seq));
    const finish = api.calls.find((c) => c.path.endsWith("/finish"));
    assert.deepEqual(finish?.body, { status: "succeeded", exitCode: 0 });
    const create = api.calls.find((c) => c.path === "/api/agent-runs");
    assert.deepEqual(create?.body, { runBoxId: "rb1", agent: "codex", prompt: "fix it" });
  });

  it("still runs when the server lacks /api/agent-runs (404)", async () => {
    const api = fakeApi({ runs: 404 });
    const { exec } = fakeExec({ stdout: SUCCESS });
    const events: CodexPanelEvent[] = [];
    const start = await sessions({ api, exec }).run(1, (e) => events.push(e), "rb1", "hi", { projectId: "p1" });
    assert.equal(start.runId, null);
    assert.equal(start.recorded, false);
    assert.match(start.recordNote ?? "", /Not recorded/);
    const finished = await waitFor(events, (e) => "type" in e && e.type === "run-finished");
    assert.equal((finished as { status: string }).status, "succeeded");
    assert.equal(api.calls.filter((c) => c.path.includes("/events")).length, 0);
  });

  it("refuses to start when the server says the environment is not ready (409)", async () => {
    const api = fakeApi({ runs: 409 });
    const { exec, commands } = fakeExec({ stdout: SUCCESS });
    await assert.rejects(
      sessions({ api, exec }).run(1, () => {}, "rb1", "hi", { projectId: "p1" }),
      /not ready/,
    );
    assert.equal(commands.length, 0);
  });

  it("stop kills the remote process group and marks the run cancelled", async () => {
    const { exec } = fakeExec({ stderr: "AGENTCLOUD_PID=4242 AGENTCLOUD_PGID=4242\n", hang: true });
    const { collect, collected } = collector();
    const events: CodexPanelEvent[] = [];
    const s = sessions({ exec, collect });
    const start = await s.run(7, (e) => events.push(e), "rb1", "loop", { projectId: "p1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await s.stop(99, start.sessionId), { stopped: false, verified: false }, "other owners cannot stop");
    assert.deepEqual(await s.stop(7, start.sessionId), { stopped: true, verified: true });
    assert.match(collected.at(-1)?.command ?? "", /kill -TERM -- -4242/);
    const finished = await waitFor(events, (e) => "type" in e && e.type === "run-finished");
    assert.equal((finished as { status: string }).status, "cancelled");
    assert.equal((finished as { stopVerified?: boolean }).stopVerified, true);
  });
});

describe("login", () => {
  it("emits device-code and signed-in, after forcing the file credential store", async () => {
    const stdout = readFileSync(path.join(here, "fixtures/codex/device-auth-stdout.txt"), "utf8");
    const { exec } = fakeExec({ stdout, stderr: "AGENTCLOUD_PID=5 AGENTCLOUD_PGID=5\nSuccessfully logged in\n" });
    const { collect, collected } = collector();
    const events: CodexPanelEvent[] = [];
    const s = sessions({ exec, collect });
    const { sessionId } = await s.login(1, (e) => events.push(e), "rb1");
    assert.equal(collected[0].command, ENSURE_FILE_STORE_COMMAND);
    const code = await waitFor(events, (e) => "type" in e && e.type === "device-code");
    assert.deepEqual(
      { url: (code as { url: string }).url, code: (code as { code: string }).code },
      { url: "https://auth.openai.com/codex/device", code: "ABCD-EFGH1" },
    );
    assert.equal(s.deviceUrl(1, sessionId), "https://auth.openai.com/codex/device");
    assert.equal(s.deviceUrl(2, sessionId), null);
    const signed = await waitFor(events, (e) => "type" in e && e.type === "signed-in");
    assert.equal((signed as { detail: string }).detail, "Logged in using ChatGPT");
  });

  it("adds the ChatGPT device-code hint when sign-in fails", async () => {
    const { exec } = fakeExec({ stderr: "Error logging in with device code: device auth failed with status 403\n", exitCode: 1 });
    const { collect } = collector();
    const events: CodexPanelEvent[] = [];
    await sessions({ exec, collect }).login(1, (e) => events.push(e), "rb1");
    const error = await waitFor(events, (e) => "type" in e && e.type === "error");
    assert.match((error as { message: string }).message, /status 403[\s\S]*Sign in with Device Code/);
  });
});

describe("useLocalLogin", () => {
  it("sends the auth file only as stdin and returns only the status", async () => {
    const { collect, collected } = collector();
    const result = await sessions({ collect }).useLocalLogin("rb1");
    assert.deepEqual(result, { signedIn: true, detail: "Logged in using ChatGPT", localLoginAvailable: true });
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    const install = collected.find((c) => c.command === INSTALL_AUTH_COMMAND);
    assert.equal(install?.stdin, SECRET, "content goes to the box via stdin");
    assert.ok(collected.every((c) => !c.command.includes("SECRET")), "never in a command line");
    assert.equal(collected[0].command, ENSURE_FILE_STORE_COMMAND);
  });

  it("refuses when this Mac has no Codex login", async () => {
    await assert.rejects(sessions({ hasLocal: false }).useLocalLogin("rb1"), /no Codex login/);
  });

  it("the preload bridge sends only the environment id over IPC", async () => {
    const sent: unknown[][] = [];
    const ipc = {
      invoke: async (...args: unknown[]) => {
        sent.push(args);
        return { signedIn: true, detail: "Logged in using ChatGPT", localLoginAvailable: true };
      },
      on: () => {},
      removeListener: () => {},
    };
    const bridge = createCodexBridge(ipc as never);
    const status = await bridge.useLocalLogin("rb1");
    assert.deepEqual(sent, [["codex:useLocalLogin", "rb1"]]);
    assert.doesNotMatch(JSON.stringify(status), /SECRET/);
  });
});

describe("RunRecorder", () => {
  it("splits large batches at 200 events", async () => {
    const api = fakeApi();
    const recorder = new RunRecorder({ request: api.request, flushIntervalMs: 5 });
    await recorder.start("rb1", "x".repeat(5000));
    assert.equal((api.calls[0].body as { prompt: string }).prompt.length, 4000);
    for (let seq = 1; seq <= 450; seq += 1) {
      recorder.push({ seq, kind: "status", actor: "codex", text: "t", at: new Date(0).toISOString() });
    }
    await recorder.finish("succeeded", 0);
    const sizes = api.calls
      .filter((c) => c.path.endsWith("/events"))
      .map((c) => (c.body as { events: unknown[] }).events.length);
    assert.equal(sizes.reduce((a, b) => a + b, 0), 450);
    assert.ok(sizes.every((n) => n <= 200));
  });

  it("stops recording, with a note, when events start returning 404", async () => {
    const api = fakeApi({ events: 404 });
    const notes: string[] = [];
    const recorder = new RunRecorder({ request: api.request, flushIntervalMs: 5, onUnrecorded: (n) => notes.push(n) });
    await recorder.start("rb1", "p");
    recorder.push({ seq: 1, kind: "status", actor: "codex", at: new Date(0).toISOString() });
    await recorder.flush();
    assert.equal(recorder.recorded, false);
    assert.equal(notes.length, 1);
  });
});
