import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeOpenSshPublicKey } from "../electron/device-key.ts";
import type { OpenShellOptions, ShellHandlers } from "../electron/ssh-terminal.ts";
import { TerminalSessions } from "../electron/terminal-sessions.ts";
import type { TerminalEvent } from "../src/lib/types.ts";

const hostPublicKey = encodeOpenSshPublicKey(Buffer.alloc(32, 3));

function harness(status = 200, body: unknown = {
  host: "127.0.0.1",
  port: 2222,
  username: "agentcloud",
  hostPublicKey,
}) {
  const writes: string[] = [];
  const opened: OpenShellOptions[] = [];
  let handlers: ShellHandlers | null = null;
  let closed = 0;
  const sessions = new TerminalSessions({
    request: async () => new Response(JSON.stringify(body), { status }),
    privateKey: () => "PRIVATE",
    open: async (options, h) => {
      opened.push(options);
      handlers = h;
      return {
        write: (data) => writes.push(data),
        resize: () => {},
        close: () => {
          closed += 1;
        },
      };
    },
  });
  return {
    sessions,
    writes,
    opened,
    get handlers() {
      return handlers;
    },
    get closed() {
      return closed;
    },
  };
}

describe("TerminalSessions", () => {
  it("uses API connection details and routes events by session id", async () => {
    const h = harness();
    const events: TerminalEvent[] = [];
    const result = await h.sessions.open(1, (e) => events.push(e), "session-0001", "job1", {
      cols: 90,
      rows: 30,
    });
    assert.equal(result.host, "127.0.0.1");
    assert.equal(h.opened[0].hostPublicKey, hostPublicKey);
    assert.equal(h.opened[0].cols, 90);
    h.handlers?.onData("hi");
    assert.deepEqual(events, [{ type: "data", sessionId: "session-0001", data: "hi" }]);
    h.handlers?.onClose({ error: "boom" });
    assert.deepEqual(events[1], { type: "closed", sessionId: "session-0001", error: "boom" });
    assert.equal(h.sessions.size, 0);
  });

  it("only lets the owning renderer write or close", async () => {
    const h = harness();
    await h.sessions.open(1, () => {}, "session-0002", "job1", { cols: 80, rows: 24 });
    h.sessions.write(2, "session-0002", "rm -rf /\n");
    h.sessions.close(2, "session-0002");
    assert.deepEqual(h.writes, []);
    assert.equal(h.closed, 0);
    h.sessions.write(1, "session-0002", "ls\n");
    assert.deepEqual(h.writes, ["ls\n"]);
    h.sessions.closeOwner(1);
    assert.equal(h.closed, 1);
    assert.equal(h.sessions.size, 0);
  });

  it("surfaces the connection API error and does not open a shell", async () => {
    const h = harness(403, { error: "nope", code: "no_authorized_key" });
    await assert.rejects(
      h.sessions.open(1, () => {}, "session-0003", "job1", { cols: 80, rows: 24 }),
      /created on the web before this device registered its key/,
    );
    assert.equal(h.opened.length, 0);
    assert.equal(h.sessions.size, 0);
  });

  it("rejects malformed session ids", async () => {
    const h = harness();
    await assert.rejects(
      h.sessions.open(1, () => {}, "x", "job1", { cols: 80, rows: 24 }),
      /Invalid terminal session id/,
    );
  });
});
