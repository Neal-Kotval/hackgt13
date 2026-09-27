import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createCodexRpcClient, MAX_FRAME } from "../lib/codex-rpc.mjs";

function fakeChild({ autoInit = true } = {}) {
  const child = new EventEmitter();
  const messages = [];
  let kills = 0;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { kills += 1; child.emit("exit", null); return true; };
  child.stdin = new Writable({ write(data, _encoding, done) {
    const message = JSON.parse(data.toString()); messages.push(message);
    if (autoInit && message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n"));
    done();
  } });
  return { child, messages, kills: () => kills };
}

test("initialize sends initialize then initialized and routes notifications", async () => {
  const f = fakeChild(); const events = [];
  const client = createCodexRpcClient(f.child, { onNotification: (...args) => events.push(args) });
  await client.initialize();
  assert.deepEqual(f.messages.map((m) => m.method), ["initialize", "initialized"]);
  f.child.stdout.write('{"method":"thread/started","params":{"threadId":"t"}}\n');
  assert.deepEqual(events, [["thread/started", { threadId: "t" }]]);
  client.close();
});

test("server requests are declined or not supported; error text is never propagated", async () => {
  const f = fakeChild(); const client = createCodexRpcClient(f.child); await client.initialize();
  f.child.stdout.write('{"id":7,"method":"item/fileChange/requestApproval","params":{}}\n{"id":8,"method":"x","params":{}}\n');
  assert.deepEqual(f.messages.find((m) => m.id === 7), { id: 7, result: { decision: "decline" } });
  assert.equal(f.messages.find((m) => m.id === 8).error.code, -32601);
  const pending = client.request("account/read");
  f.child.stdout.write(JSON.stringify({ id: f.messages.at(-1).id, error: { message: "sk-secret-value" } }) + "\n");
  await assert.rejects(pending, (error) => !error.message.includes("sk-secret-value"));
  client.close();
});

test("frame limit, timeout, and EOF-then-kill shutdown", async () => {
  const f = fakeChild(); const exits = [];
  const client = createCodexRpcClient(f.child, { requestTimeoutMs: 50, killDelayMs: 20, onExit: (e) => exits.push(e) });
  await client.initialize();
  const big = client.request("thread/read");
  f.child.stdout.write("x".repeat(MAX_FRAME + 1));
  await assert.rejects(big, /exceeds/);
  assert.equal(exits.length, 1);
  assert.equal(f.child.stdin.writableEnded, true);
  assert.equal(f.kills(), 0, "kill waits for EOF to reach app-server");
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(f.kills(), 1);
  const g = fakeChild(); const timed = createCodexRpcClient(g.child, { requestTimeoutMs: 20, killDelayMs: 10 });
  await timed.initialize();
  await assert.rejects(timed.request("thread/start"), /timed out/);
  await assert.rejects(timed.request("thread/read"), /closed/);
});

test("custom connect error message is used for spawn failures", async () => {
  const f = fakeChild({ autoInit: false });
  const client = createCodexRpcClient(f.child, { connectErrorMessage: "Could not start ssh." });
  const init = client.initialize();
  f.child.emit("error", new Error("spawn ssh ENOENT"));
  await assert.rejects(init, /Could not start ssh\./);
});
