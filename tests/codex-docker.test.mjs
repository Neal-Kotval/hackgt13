import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CODEX_IMAGE, createCodexDockerRuntime, stopCodexContainer } from "../lib/codex-docker.mjs";

const sessionId = "12345678-1234-1234-1234-123456789abc";
const installId = "test-install";
function fixture(options = {}) {
  const calls = [];
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit("exit", 0); return true; };
  child.stdin = new Writable({ write(data, encoding, done) {
    const message = JSON.parse(data.toString()); messages.push(message);
    if (message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n"));
    done();
  } });
  const exec = async (args) => {
    calls.push(args);
    if (args[0] === "image") return { code: 0, stdout: "sha256:demo" };
    if (args[1] === "inspect") {
      const value = args[0] === "volume" ? options.volume : options.container;
      return value ? { code: 0, stdout: JSON.stringify([value]) } : { code: 1, stderr: "Error: No such object" };
    }
    return { code: 0, stdout: "" };
  };
  const deps = { exec, spawnProcess: (command, args) => { calls.push([command, ...args]); return child; }, requestTimeoutMs: 100 };
  const start = (callbacks = {}) => createCodexDockerRuntime({ sessionId, installId, ...callbacks }, deps);
  return { start, calls, messages, child };
}

test("isolated container, initialization, newline framing, and notification routing", async () => {
  const f = fixture(); const events = [];
  const runtime = await f.start({ onNotification: (...args) => events.push(args) });
  assert.deepEqual(f.messages.map((m) => m.method), ["initialize", "initialized"]);
  const run = f.calls.find((c) => c[0] === "run");
  assert.ok(run.includes(CODEX_IMAGE));
  for (const flag of ["--read-only", "--cap-drop", "--security-opt", "--memory", "--cpus", "--pids-limit"]) assert.ok(run.includes(flag));
  assert.ok(!run.includes("--publish")); assert.ok(!run.join(" ").includes("docker.sock"));
  const promise = runtime.request("account/read", {}); const id = f.messages.at(-1).id;
  f.child.stdout.write(`{"id":${id},"result":`);
  f.child.stdout.write('{"account":null}}\n{"method":"thread/started","params":{"threadId":"demo"}}\n');
  assert.deepEqual(await promise, { account: null });
  assert.deepEqual(events, [["thread/started", { threadId: "demo" }]]);
  runtime.close(); assert.ok(!f.calls.some((c) => c[0] === "stop"));
});

test("rejects unowned volumes and invalid identities before starting processes", async () => {
  const f = fixture({ volume: { Labels: {} } });
  await assert.rejects(f.start(), /does not belong/);
  assert.ok(!f.calls.some((c) => c[0] === "run"));
  await assert.rejects(createCodexDockerRuntime({ sessionId: "../../bad", installId }), /Invalid/);
});

test("declines approvals and rejects unsupported server methods", async () => {
  const f = fixture(); const runtime = await f.start();
  f.child.stdout.write('{"id":90,"method":"item/commandExecution/requestApproval","params":{}}\n{"id":91,"method":"unknown","params":{}}\n');
  assert.deepEqual(f.messages.find((m) => m.id === 90), { id: 90, result: { decision: "decline" } });
  assert.equal(f.messages.find((m) => m.id === 91).error.code, -32601);
  runtime.close();
});

test("redacts server error text and rejects pending requests on process exit", async () => {
  const f = fixture(); const runtime = await f.start();
  const failed = runtime.request("account/login/start", { apiKey: "secret-never-log" });
  const rejected = assert.rejects(failed, (error) => !error.message.includes("secret-never-log"));
  f.child.stdout.write(JSON.stringify({ id: f.messages.at(-1).id, error: { message: "secret-never-log" } }) + "\n");
  await rejected;
  const pending = assert.rejects(runtime.request("thread/read"), /exited/);
  f.child.emit("exit", 1); await pending;
});

test("timeouts disconnect to prevent ambiguous requests continuing on the same transport", async () => {
  const f = fixture(); const runtime = await f.start();
  await assert.rejects(runtime.request("thread/start"), /timed out/);
  await assert.rejects(runtime.request("thread/read"), /closed/);
});

test("oversized responses terminate transport, stop retains workspace volume", async () => {
  const f = fixture(); const runtime = await f.start();
  const pending = assert.rejects(runtime.request("thread/read"), /exceeds/);
  f.child.stdout.write("x".repeat(2 * 1024 * 1024 + 1)); await pending;
  await runtime.stop();
  assert.ok(f.calls.some((c) => c[0] === "stop"));
  assert.ok(!f.calls.some((c) => c.includes("rm")));
});

function ownedContainer(overrides = {}) {
  return {
    Image: "sha256:demo",
    Config: { Image: CODEX_IMAGE, User: "node", Labels: { "com.agentcloud.codex.install": installId, "com.agentcloud.codex.session": sessionId } },
    Mounts: [{ Type: "volume", Name: `agentcloud-codex-${installId}-${sessionId}-home`, Destination: "/home/node", RW: true }],
    HostConfig: { Privileged: false, NetworkMode: "default", ReadonlyRootfs: true, Memory: 2 * 1024 ** 3, NanoCpus: 2_000_000_000, PidsLimit: 256, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], PortBindings: {} },
    State: { Running: false },
    ...overrides,
  };
}

test("reconnect starts an owned stopped container and refuses injected host mounts", async () => {
  const f = fixture({ container: ownedContainer() }); const runtime = await f.start();
  assert.ok(f.calls.some((c) => c[0] === "start"));
  assert.ok(!f.calls.some((c) => c[0] === "run")); runtime.close();
  const hostile = fixture({ container: ownedContainer({ Mounts: [{ Type: "bind", Source: "/", Destination: "/host" }] }) });
  await assert.rejects(hostile.start(), /does not match/);
  assert.ok(!hostile.calls.some((c) => ["start", "run", "docker"].includes(c[0])));
});

test("does not mistake Docker daemon failures for absent resources", async () => {
  let calls = 0;
  await assert.rejects(createCodexDockerRuntime({ sessionId, installId }, {
    exec: async () => ++calls === 1 ? { code: 0, stdout: "sha256:demo" } : { code: 1, stderr: "Cannot connect to the Docker daemon" },
  }), /Cannot inspect/);
  assert.equal(calls, 2);
});

test("malformed protocol rejects pending work and reports exit once", async () => {
  const f = fixture(); const exits = [];
  const runtime = await f.start({ onExit: (event) => exits.push(event) });
  const pending = assert.rejects(runtime.request("thread/read"), /invalid protocol/);
  f.child.stdout.write("not json\n"); await pending;
  runtime.close(); assert.equal(exits.length, 1);
});

test("standalone stop never creates resources or starts app-server", async () => {
  const calls = [];
  const exec = async args => { calls.push(args); return { code: 1, stderr: 'No such container' }; };
  assert.deepEqual(await stopCodexContainer({sessionId,installId},{exec}),{stopped:true});
  assert.deepEqual(calls.map(x=>x.slice(0,2)),[['container','inspect']]);
});

test("standalone stop validates ownership then stops without image build or protocol", async () => {
  const calls = [];
  const container = ownedContainer({State:{Running:true}});
  const volume = { Driver:'local', Labels:container.Config.Labels };
  const exec = async args => { calls.push(args); return {code:0,stdout:JSON.stringify([args[0]==='container'?container:volume])}; };
  await stopCodexContainer({sessionId,installId},{exec});
  assert.deepEqual(calls.map(x=>x[0]),['container','volume','stop']);
  container.Config.Labels = {};
  await assert.rejects(stopCodexContainer({sessionId,installId},{exec}),/does not belong/);
  assert.equal(calls.filter(x=>x[0]==='stop').length,1);
});
