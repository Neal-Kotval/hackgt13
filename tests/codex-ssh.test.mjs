import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { after, test } from "node:test";
import Database from "better-sqlite3";
import { migrateRunBoxJobs } from "../lib/run-box-jobs.mjs";
import { knownHostsLine, migrateRunBoxSsh, recordRunBoxSshEndpoint } from "../lib/run-box-ssh.mjs";
import { migrateAgentCheck, recordWorkspacePath } from "../lib/agent-check.mjs";
import { sshFingerprint } from "../lib/ssh-keys.mjs";
import { classifySshFailure, createCodexSshRuntime, NEW_ENVIRONMENT_REQUIRED, remoteCodexCommand } from "../lib/codex-ssh.mjs";
import { ed25519PublicKey } from "./ssh-key-fixture.mjs";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "codex-ssh-test-"));
after(() => rmSync(tmpRoot, { recursive: true, force: true }));
const runnerPublic = ed25519PublicKey();
const runner = { keyFile: "/secure/codex-runner/id_ed25519", fingerprint: sshFingerprint(runnerPublic) };
const hostKey = ed25519PublicKey();

function database({ state = "ready", serverFingerprint = runner.fingerprint, workspace = "/home/agentcloud/workspace/repo" } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  migrateRunBoxJobs(db); migrateRunBoxSsh(db); migrateAgentCheck(db);
  const id = "11111111-2222-3333-4444-555555555555", at = new Date().toISOString();
  db.prepare(`INSERT INTO run_box_job (id, decision_id, project_id, provider, profile_id, max_duration_minutes, state, created_at, updated_at)
    VALUES (?, 'd', 'p', 'docker-local', 'local-docker-sandbox', 60, ?, ?, ?)`).run(id, state, at, at);
  recordRunBoxSshEndpoint(db, id, { host: "127.0.0.1", port: 2222, username: "agentcloud", hostPublicKey: hostKey,
    authorizedFingerprints: [], serverFingerprint });
  recordWorkspacePath(db, id, workspace);
  return { db, id };
}

function fakeSpawn({ respond = true, stderr = null } = {}) {
  const calls = []; const messages = [];
  const spawnProcess = (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const knownHosts = args.find((arg) => arg.startsWith("UserKnownHostsFile=")).slice("UserKnownHostsFile=".length);
    calls.push({ command, args, knownHosts, content: readFileSync(knownHosts, "utf8"), mode: statSync(knownHosts).mode & 0o777 });
    child.kill = () => { queueMicrotask(() => child.emit("exit", null)); return true; };
    child.stdin = new Writable({
      write(data, _encoding, done) {
        const message = JSON.parse(data.toString()); messages.push(message);
        if (respond && message.method === "initialize") queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n"));
        done();
      },
      final(done) { queueMicrotask(() => child.emit("exit", 0)); done(); },
    });
    if (stderr) queueMicrotask(() => { child.stderr.write(stderr); child.emit("exit", 255); });
    return child;
  };
  return { spawnProcess, calls, messages };
}

const deps = (db, spawn, extra = {}) => ({ db, getRunnerKey: async () => runner, spawnProcess: spawn.spawnProcess, tmpRoot,
  requestTimeoutMs: 500, failureGraceMs: 50, killDelayMs: 20, ...extra });

test("runs pinned, non-interactive ssh with the server key and deletes known_hosts on close", async () => {
  const { db, id } = database(); const spawn = fakeSpawn(); const events = [];
  const runtime = await createCodexSshRuntime({ runBoxId: id, onNotification: (...args) => events.push(args) }, deps(db, spawn));
  const [call] = spawn.calls;
  assert.equal(call.command, "ssh");
  for (const option of ["BatchMode=yes", "IdentitiesOnly=yes", "StrictHostKeyChecking=yes", "IdentityAgent=none", "GlobalKnownHostsFile=/dev/null"])
    assert.ok(call.args.includes(option), option);
  assert.ok(call.args.includes("-T"));
  assert.equal(call.args[call.args.indexOf("-i") + 1], runner.keyFile);
  assert.equal(call.args[call.args.indexOf("-p") + 1], "2222");
  assert.equal(call.args.at(-2), "agentcloud@127.0.0.1");
  assert.equal(call.args.at(-1), "cd '/home/agentcloud/workspace/repo' && exec codex app-server");
  assert.equal(call.content, `${knownHostsLine({ host: "127.0.0.1", port: 2222, hostPublicKey: hostKey })}\n`);
  assert.equal(call.mode, 0o600);
  assert.ok(call.knownHosts.startsWith(tmpRoot));
  assert.equal(statSync(path.dirname(call.knownHosts)).mode & 0o777, 0o700);
  assert.deepEqual(spawn.messages.map((m) => m.method), ["initialize", "initialized"]);
  runtime.close();
  assert.equal(existsSync(call.knownHosts), false);
  assert.deepEqual(readdirSync(tmpRoot), []);
  db.close();
});

test("workspace paths are quoted for the remote shell and validated", () => {
  assert.equal(remoteCodexCommand("/home/agentcloud/it's; rm -rf ~"), "cd '/home/agentcloud/it'\\''s; rm -rf ~' && exec codex app-server");
  assert.throws(() => remoteCodexCommand("/etc"), /workspace/);
  assert.throws(() => remoteCodexCommand("/home/agentcloud/../root"), /workspace/);
});

test("environments without this install's server key ask for a new environment and never spawn ssh", async () => {
  for (const serverFingerprint of [null, sshFingerprint(ed25519PublicKey())]) {
    const { db, id } = database({ serverFingerprint }); const spawn = fakeSpawn();
    await assert.rejects(createCodexSshRuntime({ runBoxId: id }, deps(db, spawn)), (error) => error.publicMessage === NEW_ENVIRONMENT_REQUIRED);
    assert.equal(spawn.calls.length, 0); db.close();
  }
  const { db, id } = database({ state: "stopping" }); const spawn = fakeSpawn();
  await assert.rejects(createCodexSshRuntime({ runBoxId: id }, deps(db, spawn)), (error) => error.publicMessage === "Environment stopped");
  db.close();
});

test("host-key mismatch and refused keys map to clear errors without ssh text", async () => {
  const cases = [
    ["@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n", /host key does not match/],
    ["agentcloud@127.0.0.1: Permission denied (publickey).\n", /refused the server's SSH key\. Create a new environment/],
  ];
  for (const [stderr, expected] of cases) {
    const { db, id } = database(); const spawn = fakeSpawn({ respond: false, stderr });
    await assert.rejects(createCodexSshRuntime({ runBoxId: id }, deps(db, spawn)), (error) =>
      expected.test(error.publicMessage) && !error.message.includes("127.0.0.1") && !error.message.includes("WARNING"));
    assert.deepEqual(readdirSync(tmpRoot), []);
    db.close();
  }
  assert.equal(classifySshFailure("some unknown text"), null);
});
