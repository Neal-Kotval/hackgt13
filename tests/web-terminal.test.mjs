import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import ssh2 from "ssh2";
import { migrateRunBoxJobs, requestRunBoxStop } from "../lib/run-box-jobs.mjs";
import { migrateRunBoxSsh, recordRunBoxSshEndpoint } from "../lib/run-box-ssh.mjs";
import { migrateAgentCheck, recordWorkspacePath } from "../lib/agent-check.mjs";
import { sshFingerprint } from "../lib/ssh-keys.mjs";
import {
  createWebTerminalService, IDLE_TIMEOUT_MS, listTerminalEvents, openPinnedShell, pinnedHostKey, terminalCommand, WebTerminalError,
} from "../lib/web-terminal.mjs";
import { ed25519PublicKey } from "./ssh-key-fixture.mjs";

const runnerPublic = ed25519PublicKey();
const runner = { keyFile: "/secure/codex-runner/id_ed25519", fingerprint: sshFingerprint(runnerPublic) };
const hostKey = ed25519PublicKey();
const PROJECT = "project-1";
const ALICE = "employee-alice";
const BOB = "employee-bob";
const services = [];
after(() => { for (const service of services) service.dispose(); });

function database({ state = "ready", serverFingerprint = runner.fingerprint, createdAt = new Date(), minutes = 60 } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrateRunBoxJobs(db); migrateRunBoxSsh(db); migrateAgentCheck(db);
  const id = "11111111-2222-3333-4444-555555555555", at = createdAt.toISOString();
  db.prepare(`INSERT INTO run_box_job (id, decision_id, project_id, provider, profile_id, max_duration_minutes, state, created_at, updated_at)
    VALUES (?, 'd', ?, 'docker-local', 'local-docker-sandbox', ?, ?, ?, ?)`).run(id, PROJECT, minutes, state, at, at);
  recordRunBoxSshEndpoint(db, id, { host: "127.0.0.1", port: 2222, username: "agentcloud", hostPublicKey: hostKey,
    authorizedFingerprints: [], serverFingerprint });
  recordWorkspacePath(db, id, "/home/agentcloud/workspace/repo");
  return { db, id };
}

// Fake SSH spawner: records every shell it opens and lets the test drive output.
function fakeShells({ gate = null, fail = false } = {}) {
  const shells = [];
  const openShell = async (options, handlers) => {
    const shell = { options, handlers, writes: [], sizes: [], closed: false, keyWasBuffer: Buffer.isBuffer(options.privateKey), keyRef: options.privateKey };
    shells.push(shell);
    if (gate) await gate;
    if (fail) throw new Error("ssh: connect to host 127.0.0.1 port 2222: Connection refused secret-stderr");
    return {
      write(data) { shell.writes.push(data); },
      resize(cols, rows) { shell.sizes.push([cols, rows]); },
      close() { shell.closed = true; },
    };
  };
  return { shells, openShell };
}

function service(db, overrides = {}) {
  let clock = overrides.start ?? Date.now();
  const stops = new Set();
  const created = createWebTerminalService({
    db,
    getRunnerKey: async () => runner,
    readKey: () => Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----\n"),
    now: () => clock,
    sweepMs: 0,
    attachTimeoutMs: overrides.attachTimeoutMs ?? 60_000,
    subscribeStop: "subscribeStop" in overrides ? overrides.subscribeStop : ((listener) => { stops.add(listener); return () => stops.delete(listener); }),
    ...overrides.deps,
  });
  services.push(created);
  return { service: created, advance(ms) { clock += ms; }, stops };
}

const openArgs = (id, employeeId = ALICE) => ({ employeeId, projectId: PROJECT, jobId: id, cols: 120, rows: 30 });

test("opens a PTY with the runner key and pinned host key, in the workspace", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  const { service: terminals } = service(db, { deps: { openShell: fake.openShell } });
  const opened = await terminals.open(openArgs(id));
  assert.match(opened.sessionId, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(opened.idleTimeoutMs, IDLE_TIMEOUT_MS);
  const [shell] = fake.shells;
  assert.equal(shell.options.host, "127.0.0.1");
  assert.equal(shell.options.port, 2222);
  assert.equal(shell.options.username, "agentcloud");
  assert.equal(shell.options.hostPublicKey, hostKey);
  assert.equal(shell.options.command, terminalCommand("/home/agentcloud/workspace/repo"));
  assert.match(shell.options.command, /^cd '\/home\/agentcloud\/workspace\/repo'/);
  assert.deepEqual([shell.options.cols, shell.options.rows], [120, 30]);
  // The private key is handed over as a Buffer and zeroed once SSH is set up.
  assert.equal(shell.keyWasBuffer, true);
  assert.ok(shell.keyRef.every((byte) => byte === 0));
  assert.deepEqual(listTerminalEvents(db, id).map((row) => [row.employee_id, row.event]), [[ALICE, "opened"]]);
});

test("refuses environments that are not ready, lack the server key, or are in another project", async () => {
  for (const state of ["queued", "verifying", "stopping", "stopped", "failed"]) {
    const { db, id } = database({ state });
    const { service: terminals } = service(db, { deps: { openShell: fakeShells().openShell } });
    await assert.rejects(terminals.open(openArgs(id)), (error) => error instanceof WebTerminalError && error.status === 409 && error.code === "not_ready");
  }
  const noKey = database({ serverFingerprint: null });
  await assert.rejects(service(noKey.db, { deps: { openShell: fakeShells().openShell } }).service.open(openArgs(noKey.id)),
    (error) => error.status === 409 && error.code === "no_server_key");
  const { db, id } = database();
  const { service: terminals } = service(db, { deps: { openShell: fakeShells().openShell } });
  await assert.rejects(terminals.open({ ...openArgs(id), projectId: "other-project" }), (error) => error.status === 404);
  await assert.rejects(terminals.open({ ...openArgs(id), jobId: "missing" }), (error) => error.status === 404);
  db.prepare("UPDATE run_box_job SET stop_requested_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  await assert.rejects(terminals.open(openArgs(id)), (error) => error.code === "not_ready");
});

test("the environment's lifetime caps the session: no open after it, and an open session closes at it", async () => {
  const old = database({ createdAt: new Date(Date.now() - 61 * 60_000) });
  await assert.rejects(service(old.db, { deps: { openShell: fakeShells().openShell } }).service.open(openArgs(old.id)),
    (error) => error.code === "not_ready");

  const { db, id } = database({ createdAt: new Date(Date.now() - 50 * 60_000) });
  const fake = fakeShells();
  const { service: terminals, advance } = service(db, { deps: { openShell: fake.openShell } });
  const { sessionId, expiresAt } = await terminals.open(openArgs(id));
  assert.ok(Date.parse(expiresAt) - Date.now() <= 10 * 60_000 + 1000);
  const events = [];
  terminals.attach(sessionId, ALICE, id, (event) => events.push(event));
  advance(9 * 60_000);
  terminals.input(sessionId, ALICE, id, "ls\r");
  terminals.sweep();
  assert.equal(terminals.size, 1);
  advance(2 * 60_000);
  terminals.sweep();
  assert.equal(terminals.size, 0);
  assert.equal(fake.shells[0].closed, true);
  assert.equal(events.at(-1).reason, "environment_expired");
});

test("a session id is bound to the employee and job that opened it", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  const { service: terminals } = service(db, { deps: { openShell: fake.openShell } });
  const alice = await terminals.open(openArgs(id, ALICE));
  const notFound = (error) => error instanceof WebTerminalError && error.status === 404 && error.message === "Terminal session not found";
  assert.throws(() => terminals.attach(alice.sessionId, BOB, id, () => {}), notFound);
  assert.throws(() => terminals.input(alice.sessionId, BOB, id, "whoami\r"), notFound);
  assert.throws(() => terminals.resize(alice.sessionId, BOB, id, 100, 40), notFound);
  assert.throws(() => terminals.close(alice.sessionId, BOB, id), notFound);
  assert.throws(() => terminals.session(alice.sessionId, BOB, id), notFound);
  assert.throws(() => terminals.input(alice.sessionId, ALICE, "another-job", "x"), notFound);
  assert.throws(() => terminals.input("not-a-session", ALICE, id, "x"), notFound);
  assert.deepEqual(fake.shells[0].writes, []);
  assert.equal(fake.shells[0].closed, false);
  // Bob's failed attempts neither attached nor closed Alice's session.
  terminals.input(alice.sessionId, ALICE, id, "pwd\r");
  assert.deepEqual(fake.shells[0].writes, ["pwd\r"]);
});

test("sessions are isolated from each other and allow one stream each", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  const { service: terminals } = service(db, { deps: { openShell: fake.openShell } });
  const first = await terminals.open(openArgs(id));
  const second = await terminals.open(openArgs(id));
  assert.notEqual(first.sessionId, second.sessionId);
  const firstEvents = [], secondEvents = [];
  terminals.attach(first.sessionId, ALICE, id, (event) => firstEvents.push(event));
  terminals.attach(second.sessionId, ALICE, id, (event) => secondEvents.push(event));
  assert.throws(() => terminals.attach(first.sessionId, ALICE, id, () => {}), (error) => error.status === 409);
  terminals.input(first.sessionId, ALICE, id, "one");
  terminals.input(second.sessionId, ALICE, id, "two");
  terminals.resize(second.sessionId, ALICE, id, 90, 20);
  assert.deepEqual(fake.shells[0].writes, ["one"]);
  assert.deepEqual(fake.shells[1].writes, ["two"]);
  assert.deepEqual(fake.shells[1].sizes, [[90, 20]]);
  assert.throws(() => terminals.resize(second.sessionId, ALICE, id, 0, 20), (error) => error.status === 400);
  fake.shells[0].handlers.onData(Buffer.from("out-1"));
  fake.shells[1].handlers.onData(Buffer.from("out-2"));
  assert.deepEqual(firstEvents.map((event) => event.data.toString()), ["out-1"]);
  assert.deepEqual(secondEvents.map((event) => event.data.toString()), ["out-2"]);
});

test("output before attach is buffered; detaching (client disconnect) closes the SSH session", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  const { service: terminals } = service(db, { deps: { openShell: fake.openShell } });
  const { sessionId } = await terminals.open(openArgs(id));
  fake.shells[0].handlers.onData(Buffer.from("motd\r\n$ "));
  const events = [];
  const detach = terminals.attach(sessionId, ALICE, id, (event) => events.push(event));
  assert.equal(events[0].data.toString(), "motd\r\n$ ");
  detach();
  assert.equal(fake.shells[0].closed, true);
  assert.equal(terminals.size, 0);
  assert.throws(() => terminals.input(sessionId, ALICE, id, "x"), (error) => error.status === 404);
  assert.deepEqual(listTerminalEvents(db, id).map((row) => [row.event, row.reason]), [["opened", null], ["closed", "client_disconnected"]]);
});

test("an unattached session closes after the attach timeout", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  const { service: terminals } = service(db, { attachTimeoutMs: 20, deps: { openShell: fake.openShell } });
  await terminals.open(openArgs(id));
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(terminals.size, 0);
  assert.equal(fake.shells[0].closed, true);
  assert.equal(listTerminalEvents(db, id).at(-1).reason, "attach_timeout");
});

test("idle timeout: 15 minutes without input closes the session; input resets it", async () => {
  const { db, id } = database({ minutes: 120 });
  const fake = fakeShells();
  const { service: terminals, advance } = service(db, { deps: { openShell: fake.openShell } });
  const { sessionId } = await terminals.open(openArgs(id));
  const events = [];
  terminals.attach(sessionId, ALICE, id, (event) => events.push(event));
  advance(IDLE_TIMEOUT_MS - 1000);
  terminals.sweep();
  assert.equal(terminals.size, 1);
  terminals.input(sessionId, ALICE, id, "\r");
  advance(IDLE_TIMEOUT_MS - 1000);
  // Output alone is not activity.
  fake.shells[0].handlers.onData(Buffer.from("tick"));
  terminals.sweep();
  assert.equal(terminals.size, 1);
  advance(2000);
  terminals.sweep();
  assert.equal(terminals.size, 0);
  assert.equal(fake.shells[0].closed, true);
  assert.deepEqual(events.at(-1), { type: "close", reason: "idle_timeout", message: "Closed after 15 minutes without input." });
  assert.equal(listTerminalEvents(db, id).at(-1).reason, "idle_timeout");
});

test("stopping the environment closes its sessions (stop request, state sweep, and stop during connect)", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  // Real stop listener from lib/run-box-jobs.mjs.
  const { service: terminals } = service(db, { subscribeStop: undefined, deps: { openShell: fake.openShell } });
  const { sessionId } = await terminals.open(openArgs(id));
  const events = [];
  terminals.attach(sessionId, ALICE, id, (event) => events.push(event));
  requestRunBoxStop(db, id, ALICE);
  assert.equal(terminals.size, 0);
  assert.equal(fake.shells[0].closed, true);
  assert.equal(events.at(-1).reason, "environment_stopped");

  const other = database();
  const fake2 = fakeShells();
  const { service: swept } = service(other.db, { deps: { openShell: fake2.openShell } });
  await swept.open(openArgs(other.id));
  other.db.prepare("UPDATE run_box_job SET state = 'failed' WHERE id = ?").run(other.id);
  swept.sweep();
  assert.equal(swept.size, 0);
  assert.equal(fake2.shells[0].closed, true);

  const racing = database();
  let release;
  const fake3 = fakeShells({ gate: new Promise((resolve) => { release = resolve; }) });
  const { service: connecting, stops } = service(racing.db, { deps: { openShell: fake3.openShell } });
  const pending = connecting.open(openArgs(racing.id));
  await new Promise((resolve) => setImmediate(resolve));
  for (const listener of stops) listener(racing.id);
  release();
  await assert.rejects(pending, (error) => error.status === 409);
  assert.equal(fake3.shells[0].closed, true);
  assert.equal(connecting.size, 0);
  // No "opened" row for a session that never opened.
  assert.deepEqual(listTerminalEvents(racing.db, racing.id), []);
});

test("remote exit and per-employee limits", async () => {
  const { db, id } = database();
  const fake = fakeShells();
  const { service: terminals } = service(db, { deps: { openShell: fake.openShell, maxPerEmployee: 2 } });
  const first = await terminals.open(openArgs(id));
  await terminals.open(openArgs(id));
  await assert.rejects(terminals.open(openArgs(id)), (error) => error.status === 429);
  await terminals.open(openArgs(id, BOB));
  const events = [];
  terminals.attach(first.sessionId, ALICE, id, (event) => events.push(event));
  fake.shells[0].handlers.onClose({});
  assert.equal(events.at(-1).reason, "remote_exit");
  assert.equal(terminals.size, 2);
});

test("terminal contents, keys, and SSH errors are never logged or stored", async () => {
  const methods = ["log", "info", "warn", "error", "debug", "trace"];
  const original = Object.fromEntries(methods.map((name) => [name, console[name]]));
  const lines = [];
  for (const name of methods) console[name] = (...args) => lines.push(args.map(String).join(" "));
  const writes = [];
  const stdoutWrite = process.stdout.write, stderrWrite = process.stderr.write;
  try {
    const { db, id } = database();
    const fake = fakeShells();
    const { service: terminals } = service(db, { deps: { openShell: fake.openShell } });
    process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return stderrWrite.call(process.stderr, chunk, ...rest); };
    const { sessionId } = await terminals.open(openArgs(id));
    terminals.attach(sessionId, ALICE, id, () => {});
    terminals.input(sessionId, ALICE, id, "export TOKEN=sk-secret-input-123\r");
    fake.shells[0].handlers.onData(Buffer.from("sk-secret-output-456"));
    fake.shells[0].handlers.onClose({ error: "ssh2 raw error secret-stderr" });
    const failing = database();
    await assert.rejects(service(failing.db, { deps: { openShell: fakeShells({ fail: true }).openShell } }).service.open(openArgs(failing.id)),
      (error) => error.status === 502 && !/secret-stderr|refused/.test(error.message));
    const stored = JSON.stringify(db.prepare("SELECT * FROM run_box_terminal_event").all());
    for (const secret of ["sk-secret-input-123", "sk-secret-output-456", "secret-stderr", "PRIVATE KEY"])
      assert.equal(stored.includes(secret), false);
  } finally {
    for (const name of methods) console[name] = original[name];
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  assert.deepEqual(lines, []);
  assert.equal(writes.join("").match(/sk-secret|secret-stderr|PRIVATE KEY/), null);
});

test("pinned host keys must be well-formed ed25519 keys", () => {
  assert.equal(pinnedHostKey(hostKey).type, "ssh-ed25519");
  for (const bad of ["", "ssh-rsa AAAAB3NzaC1yc2E=", "ssh-ed25519 !!!", `ssh-ed25519 ${Buffer.from("junk").toString("base64")}`])
    assert.throws(() => pinnedHostKey(bad), (error) => error.status === 409);
  assert.equal(terminalCommand("/etc/../root"), 'cd; exec "${SHELL:-/bin/bash}" -l');
});

// Real ssh2 client against an in-process ssh2 server: PTY, resize, and host key pinning.
test("openPinnedShell: PTY over real SSH, resize, and pinned host key enforcement", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "web-terminal-ssh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keygen = (name) => {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", path.join(directory, name)]);
    return { privateKey: readFileSync(path.join(directory, name)), publicKey: readFileSync(path.join(directory, `${name}.pub`), "utf8").trim() };
  };
  const host = keygen("host"), client = keygen("client"), other = keygen("other");
  const allowed = ssh2.utils.parseKey(client.publicKey);
  const seen = { pty: null, windows: [], command: null };
  const server = new ssh2.Server({ hostKeys: [host.privateKey] }, (connection) => {
    connection.on("error", () => {}); // Rejected handshakes end with an error on the server side.
    connection.on("authentication", (context) => {
      if (context.method === "publickey" && context.username === "agentcloud" && context.key.data.equals(allowed.getPublicSSH())) {
        if (!context.signature || allowed.verify(context.blob, context.signature, context.hashAlgo)) return context.accept();
      }
      context.reject(["publickey"]);
    });
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty, _reject, info) => { seen.pty = { cols: info.cols, rows: info.rows, term: info.term }; acceptPty?.(); });
      session.on("window-change", (acceptWindow, _reject, info) => { seen.windows.push([info.cols, info.rows]); acceptWindow?.(); });
      session.on("exec", (acceptExec, _reject, info) => {
        seen.command = info.command;
        const stream = acceptExec();
        stream.write("ready$ ");
        stream.on("data", (data) => {
          if (String(data).includes("exit")) { stream.exit(0); stream.end(); } else stream.write(`echo:${data}`);
        });
      });
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const base = { host: "127.0.0.1", port, username: "agentcloud", command: terminalCommand("/home/agentcloud/workspace/repo"), cols: 100, rows: 30 };

  let output = "";
  let closedWith = null;
  const shell = await openPinnedShell({ ...base, hostPublicKey: host.publicKey, privateKey: client.privateKey },
    { onData: (chunk) => { output += chunk; }, onClose: (info) => { closedWith = info; } });
  shell.write("hello");
  shell.resize(132, 40);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(seen.pty, { cols: 100, rows: 30, term: "xterm-256color" });
  assert.equal(seen.command, base.command);
  assert.deepEqual(seen.windows, [[132, 40]]);
  assert.match(output, /ready\$ echo:hello/);
  shell.write("exit");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(closedWith, {});

  await assert.rejects(openPinnedShell({ ...base, hostPublicKey: other.publicKey, privateKey: client.privateKey },
    { onData: () => {}, onClose: () => {} }), (error) => error.code === "host_key_mismatch");
  await assert.rejects(openPinnedShell({ ...base, hostPublicKey: host.publicKey, privateKey: other.privateKey },
    { onData: () => {}, onClose: () => {} }), (error) => error.code === "ssh_failed" && /refused the server's SSH key/.test(error.message));
});

test("the periodic sweep closes sessions whose employee lost access", async () => {
  const { db, id } = database({ minutes: 120 });
  const fake = fakeShells();
  let allowed = true;
  const seen = [];
  const { service: terminals } = service(db, { deps: { openShell: fake.openShell,
    stillAllowed: (session) => { seen.push(session); return allowed; } } });
  const { sessionId } = await terminals.open(openArgs(id));
  const events = [];
  terminals.attach(sessionId, ALICE, id, (event) => events.push(event));
  terminals.sweep();
  assert.equal(terminals.size, 1);
  assert.deepEqual(seen[0], { employeeId: ALICE, projectId: PROJECT, jobId: id });
  allowed = false;
  terminals.sweep();
  assert.equal(terminals.size, 0);
  assert.equal(fake.shells[0].closed, true);
  assert.equal(events.at(-1).reason, "access_revoked");
});
