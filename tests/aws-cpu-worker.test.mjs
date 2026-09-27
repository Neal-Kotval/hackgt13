import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { claimRunBoxJob, migrateRunBoxJobs, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { setAwsApproval } from "../lib/aws-organization-approval.mjs";
import { migrateSshKeys, registerSshKey } from "../lib/ssh-keys.mjs";
import { getRunBoxSshEndpoint } from "../lib/run-box-ssh.mjs";
import { getAwsCpuEnvironment, NO_DEVICE_KEYS, workOneAwsCpuJob } from "../lib/aws-cpu-worker.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";
import { CODEX_VERSION } from "../lib/aws-cpu-provider.mjs";
import { ed25519PublicKey } from "./ssh-key-fixture.mjs";

const instanceId = "i-0abcdef0123456789";
const keyDirectory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-cpu-test-"));
const keyFile = path.join(keyDirectory, "operator");
writeFileSync(keyFile, "not a real key; the fake provider never reads it\n", { mode: 0o600 });
const operatorKey = ed25519PublicKey();
const connection = { keyFile, publicKey: operatorKey };
const cidr = "203.0.113.7/32";

function setup({ deviceKey = true, profileId = "aws-cpu" } = {}) {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE organization (id TEXT PRIMARY KEY);`);
  migrateRunBoxJobs(db);
  migrateSshKeys(db);
  db.prepare("INSERT INTO user VALUES ('employee-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
  // HAC-142: AWS runs need a platform approval for the organization.
  db.prepare("INSERT INTO organization VALUES ('org-1')").run();
  setAwsApproval(db, { organizationId: "org-1", approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: "platform-admin" });
  const device = ed25519PublicKey();
  const registered = deviceKey ? registerSshKey(db, "employee-1", { label: "Mac", publicKey: device }).key : null;
  const { job, decision } = saveRunBoxDecision(db, {
    idempotencyKey: "decision-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "org-1", projectRole: "owner",
    provider: "aws-ec2", profileId, maxDurationMinutes: 60,
    repoUrl: "https://github.com/example/repo.git",
  });
  return { db, job, decision, device, registered };
}

function fakeProvider({ hostKey = ed25519PublicKey(), readbacks = [{ state: "ready" }], instanceStates = [], agent } = {}) {
  const calls = [];
  const queue = [...readbacks];
  const states = [...instanceStates];
  return {
    calls, hostKey,
    async identifyWorker() { calls.push("identity"); },
    async allocate(job, options) { calls.push(["allocate", options]); return { InstanceId: instanceId }; },
    async inspect() {
      calls.push("inspect");
      return states.shift() || { InstanceId: instanceId, State: { Name: "running" }, PublicIpAddress: "198.51.100.20",
        LaunchTime: new Date().toISOString() };
    },
    async authorizeSsh(job, source) { calls.push(["authorize", source]); return { ruleId: "sgr-0e1f", cidr: source }; },
    async readHostKey() {
      calls.push("readHostKey");
      const next = queue.shift() || { state: "ready" };
      return next.state === "ready" ? { state: "ready", hostPublicKey: hostKey, commandId: "cmd-1" } : next;
    },
    async checkAgent(job, ssh) {
      calls.push(["checkAgent", ssh]);
      if (agent) return agent(job, ssh);
      return { account: "agentcloud", uid: 1001, workspace: `/home/agentcloud/agentcloud/${job.id}/repo`, repo_sha: "a".repeat(40),
        codex: `codex-cli ${CODEX_VERSION}`, tmux: "tmux 3.2a", git: "git version 2.47.1", node: "v22.23.3", outputSha256: "b".repeat(64) };
    },
  };
}

async function runUntilSettled(db, provider, options = {}) {
  const results = [];
  for (let cycle = 0; cycle < 10; cycle++) {
    const result = await workOneAwsCpuJob(db, provider, { workerId: "worker-1", connection, sshSourceCidr: cidr, ...options });
    if (!result) break;
    results.push(result);
    if (!result.retry) break;
  }
  return results;
}

test("aws-cpu decision keeps its profile; GPU aws-ec2 decisions stay profile-less", () => {
  const { job, decision } = setup();
  assert.equal(job.profile_id, "aws-cpu");
  assert.equal(decision.profile_id, "aws-cpu");
  const gpu = setup({ profileId: "g6-l4-small" });
  assert.equal(gpu.job.profile_id, null);
});

test("an aws-cpu job reaches ready only after bootstrap, pinned host key, and agent check", async () => {
  const { db, job, registered } = setup();
  const provider = fakeProvider({
    instanceStates: [{ InstanceId: instanceId, State: { Name: "pending" } }],
    readbacks: [{ state: "pending", step: "ssm-registration" }, { state: "pending", step: "codex" }, { state: "ready" }],
  });
  const results = await runUntilSettled(db, provider, { probeHostKey: async () => provider.hostKey });
  assert.deepEqual(results.map((result) => result.retry ? `wait:${result.reason}` : result.state), [
    "wait:Waiting for the instance to run with a public IPv4 address",
    "wait:Bootstrapping: ssm-registration",
    "wait:Bootstrapping: codex",
    "ready",
  ]);
  const allocate = provider.calls.find((call) => call[0] === "allocate")[1];
  assert.deepEqual(new Set(allocate.authorizedKeys).size, 2);
  assert.ok(allocate.authorizedKeys.includes(operatorKey));
  assert.ok(provider.calls.some((call) => call[0] === "authorize" && call[1] === cidr));
  const endpoint = getRunBoxSshEndpoint(db, job.id);
  assert.deepEqual({ host: endpoint.host, port: endpoint.port, username: endpoint.username, hostPublicKey: endpoint.hostPublicKey,
    authorizedFingerprints: endpoint.authorizedFingerprints },
  { host: "198.51.100.20", port: 22, username: "agentcloud", hostPublicKey: provider.hostKey, authorizedFingerprints: [registered.fingerprint] });
  const ssh = provider.calls.find((call) => call[0] === "checkAgent")[1];
  assert.equal(ssh.keyFile, keyFile);
  assert.equal(ssh.host, "198.51.100.20");
  const row = db.prepare("SELECT state, repo_revision FROM run_box_job WHERE id = ?").get(job.id);
  assert.deepEqual({ ...row }, { state: "ready", repo_revision: "a".repeat(40) });
  const environment = getAwsCpuEnvironment(db, job.id);
  assert.equal(environment.codex_version, `codex-cli ${CODEX_VERSION}`);
  assert.equal(environment.external_host_key_match, 1);
  assert.equal(environment.ssh_rule_id, "sgr-0e1f");
});

test("no device keys means no launch", async () => {
  const { db, job } = setup({ deviceKey: false });
  const provider = fakeProvider();
  await assert.rejects(workOneAwsCpuJob(db, provider, { workerId: "worker-1", connection, sshSourceCidr: cidr }),
    (error) => error.message === NO_DEVICE_KEYS);
  assert.ok(!provider.calls.some((call) => call[0] === "allocate"));
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
});

test("an invalid SSH source or missing operator key is rejected before any claim", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await assert.rejects(workOneAwsCpuJob(db, provider, { workerId: "worker-1", connection, sshSourceCidr: "0.0.0.0/0" }), /public IPv4 \/32/);
  await assert.rejects(workOneAwsCpuJob(db, provider, { workerId: "worker-1", connection: { keyFile }, sshSourceCidr: cidr }),
    /operator ed25519 public key/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "queued");
  assert.equal(provider.calls.length, 0);
});

test("GPU and CPU workers never claim each other's aws-ec2 jobs", async () => {
  const { db, job } = setup();
  let gpuLaunched = false;
  const gpu = { async identifyWorker() {}, async allocate() { gpuLaunched = true; } };
  assert.equal(await workOneAwsGpuJob(db, gpu, { workerId: "gpu-worker" }), null);
  assert.equal(gpuLaunched, false);
  const gpuJob = setup({ profileId: null });
  assert.equal(claimRunBoxJob(gpuJob.db, "cpu-worker", new Date(), 60_000, "aws-ec2", { profileId: "aws-cpu" }), null);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "queued");
});

test("a host key mismatch over SSH fails the job instead of retrying", async () => {
  const { db, job } = setup();
  const provider = fakeProvider({ agent: () => { const error = new Error("CPU environment host key did not match the pinned key");
    error.hostKeyMismatch = true; throw error; } });
  await assert.rejects(runUntilSettled(db, provider), /did not match the pinned key/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
});

test("an unreachable SSH path waits; a failed bootstrap fails the job", async () => {
  const waiting = setup();
  const unreachable = fakeProvider({ agent: () => { const error = new Error("CPU SSH agent check failed (exit 255)"); error.retryable = true; throw error; } });
  const [result] = await runUntilSettled(waiting.db, unreachable);
  assert.equal(result.retry, true);
  assert.equal(result.state, "verifying");
  assert.match(getAwsCpuEnvironment(waiting.db, waiting.job.id).last_wait, /not reachable yet/);

  const broken = setup();
  const provider = fakeProvider({ readbacks: [{ state: "failed", step: "node" }] });
  await assert.rejects(runUntilSettled(broken.db, provider), /bootstrap failed at step node/);
  assert.equal(broken.db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(broken.job.id).state, "failed");
});

test("a public endpoint serving a different host key fails the job", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await assert.rejects(runUntilSettled(db, provider, { probeHostKey: async () => ed25519PublicKey() }), /different host key/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
});

test("HAC-166: the worker authorizes its own /32 and the recorded requester /32 before verification", async () => {
  const { db, job } = setup();
  const { requestAwsCpuSshAccess, listAwsCpuSshAccess } = await import("../lib/aws-cpu-ssh-access.mjs");
  requestAwsCpuSshAccess(db, { jobId: job.id, cidr: "8.8.8.8/32", employeeId: "employee-1" });
  // Same address as the worker: authorizeSsh dedupes to the worker's rule.
  const provider = fakeProvider();
  const results = await runUntilSettled(db, provider, { probeHostKey: async () => provider.hostKey });
  assert.equal(results.at(-1).state, "ready");
  const authorized = provider.calls.filter((call) => call[0] === "authorize").map((call) => call[1]);
  assert.deepEqual(authorized, [cidr, "8.8.8.8/32"]);
  assert.ok(provider.calls.findIndex((call) => call[0] === "authorize" && call[1] === "8.8.8.8/32") <
    provider.calls.findIndex((call) => call[0] === "checkAgent"));
  assert.equal(listAwsCpuSshAccess(db, job.id)[0].status, "applied");
});
