import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateRunBoxJobs, onRunBoxStopRequested, requestRunBoxStop, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { migrateSshKeys, normalizePublicKey, registerSshKey } from "../lib/ssh-keys.mjs";
import { getRunBoxSshEndpoint, migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { createDockerSandboxProvider, sandboxInstallId } from "../lib/docker-sandbox-provider.mjs";
import { workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";
import { getCodexRunnerKey } from "../lib/codex-runner-key.mjs";
import { createCodexSshRuntime } from "../lib/codex-ssh.mjs";
import { createRunBoxTargets } from "../lib/codex-targets.mjs";
import { createCodexSessionService, ENVIRONMENT_STOPPED } from "../lib/codex-sessions.mjs";

// Real Docker + real ssh + real `codex app-server` (HAC-153). A docker-local
// environment is brought to ready by the real worker with the install's runner key,
// then a remote Codex session initializes over SSH and starts ChatGPT device-code
// sign-in. The sign-in is never completed.
function dockerAvailable() {
  try { execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 }); return true; }
  catch { return false; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, message, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await sleep(250); }
  throw new Error(message);
}
function sshProcesses(marker) {
  try { return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().split("\n").filter(Boolean); }
  catch { return []; }
}

test("remote Codex session over SSH on a docker-local environment", {
  skip: dockerAvailable() ? false : "docker info failed; Docker is unavailable", timeout: 20 * 60_000,
}, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-codex-remote-it-"));
  const dataDir = path.join(directory, "data");
  const tmpRoot = path.join(directory, "ssh-tmp");
  mkdirSync(tmpRoot, { mode: 0o700 });
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const provider = createDockerSandboxProvider({ installId: sandboxInstallId(directory) });
  let jobId;
  let service;
  try {
    db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
      CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
      CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
      CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
    migrateRunBoxJobs(db); migrateSshKeys(db); migrateRunBoxSsh(db);
    db.prepare("INSERT INTO user VALUES ('owner-1', 1)").run();
    db.prepare("INSERT INTO member VALUES ('owner-1', 'org-1', 'owner')").run();
    db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "device", "-f", path.join(directory, "device")]);
    registerSshKey(db, "owner-1", { label: "Owner laptop",
      publicKey: normalizePublicKey(execFileSync("cat", [path.join(directory, "device.pub")], { encoding: "utf8" })) });

    await provider.ensureImage();
    const runner = await getCodexRunnerKey({ dataDir });
    const { job } = saveRunBoxDecision(db, { idempotencyKey: "it-codex", resourceRequestId: "it-codex-request",
      projectId: "project-1", employeeId: "owner-1", organizationId: "org-1", projectRole: "owner",
      provider: "docker-local", profileId: "local-docker-sandbox", maxDurationMinutes: 60 });
    jobId = job.id;
    const ready = await workOneDockerSandboxJob(db, provider, { workerId: "it-codex-worker",
      runnerKey: { publicKey: runner.publicKey, fingerprint: runner.fingerprint } });
    assert.equal(ready.state, "ready");
    assert.equal(getRunBoxSshEndpoint(db, job.id).serverFingerprint, runner.fingerprint);

    service = createCodexSessionService({ db, dataDir, sweepMs: 0, targets: createRunBoxTargets(db),
      onStopRequested: onRunBoxStopRequested,
      runtimeFactory: (options) => createCodexSshRuntime(options, { db, tmpRoot, getRunnerKey: () => getCodexRunnerKey({ dataDir }),
        requestTimeoutMs: 60_000 }) });
    const session = service.initialize({ projectId: "project-1", agentId: "agent-1", createdBy: "owner-1", runBoxId: job.id });
    assert.deepEqual(session.target, { kind: "runBox", runBoxId: job.id, provider: "docker-local", profileId: "local-docker-sandbox", state: "ready" });
    const initialized = await until(() => ["auth_required", "error", "ready"].includes(service.get(session.id).status) && service.get(session.id),
      "Remote Codex session did not initialize");
    assert.equal(initialized.status, "auth_required", initialized.error || "");
    assert.equal(sshProcesses(tmpRoot).length, 1, "one ssh transport is open");
    assert.equal(readdirSync(tmpRoot).length, 1, "one private known_hosts directory while connected");

    // Device-code start only. The code is never entered, so no account is signed in.
    const { login } = await service.action(session.id, { action: "login" });
    assert.match(login.verificationUrl, /^https:\/\/auth\.openai\.com\//);
    assert.equal(typeof login.userCode, "string");
    assert.ok(login.userCode.length >= 4);
    assert.equal(JSON.stringify(service.snapshot(session.id)).includes(login.userCode), false);

    await service.action(session.id, { action: "interrupt" });
    await service.action(session.id, { action: "stop" });
    assert.equal(service.get(session.id).status, "stopped");
    await until(() => sshProcesses(tmpRoot).length === 0, "ssh process remained after close", 15_000);
    assert.deepEqual(readdirSync(tmpRoot), []);

    // Reconnect, then stop the environment: the session closes and records why.
    await service.action(session.id, { action: "resume" });
    assert.equal(service.get(session.id).status, "auth_required", service.get(session.id).error || "");
    assert.equal(sshProcesses(tmpRoot).length, 1);
    requestRunBoxStop(db, job.id, "owner-1");
    assert.equal(service.get(session.id).status, "error");
    assert.equal(service.get(session.id).error, ENVIRONMENT_STOPPED);
    await until(() => sshProcesses(tmpRoot).length === 0, "ssh process remained after environment stop", 15_000);
    assert.deepEqual(readdirSync(tmpRoot), []);
    const stopped = await workOneDockerSandboxJob(db, provider, { workerId: "it-codex-stop" });
    assert.equal(stopped.state, "stopped");
  } finally {
    service?.close();
    if (jobId) await provider.remove(jobId).catch(() => {});
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
