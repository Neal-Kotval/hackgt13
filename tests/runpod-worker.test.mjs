import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateSshKeys, registerSshKey, sshFingerprint } from "../lib/ssh-keys.mjs";
import { getRunBoxSshEndpoint } from "../lib/run-box-ssh.mjs";
import { migrateRunBoxJobs, requestRunBoxStop, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { migrateRunpodEvidence } from "../lib/runpod-evidence.mjs";
import { migrateRunpodCleanup } from "../lib/runpod-reconcile.mjs";
import { preflightRunpod, RUNPOD_SSH_USER, validateRunpodSshConfig, workOneRunpodJob } from "../lib/runpod-worker.mjs";
import { runpodPodName } from "../lib/runpod-provider.mjs";

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  migrateRunBoxJobs(db);
  migrateRunpodEvidence(db);
  migrateRunpodCleanup(db);
  db.prepare("INSERT INTO user VALUES ('employee-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: "idem-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "employee-1", organizationId: "org-1", projectRole: "owner",
    provider: "runpod", profileId: "runpod-rtx-4090", maxDurationMinutes: 60,
    repoUrl: "https://example.com/repo.git",
  });
  return { db, job };
}

function provider(job, overrides = {}) {
  const calls = [];
  const expiresAt = new Date(Math.floor((Date.parse(job.created_at) + job.max_duration_minutes * 60_000) / 1_000) * 1_000);
  const pod = { id: "pod123", name: runpodPodName(job.id, expiresAt), status: "RUNNING",
    gpuId: "NVIDIA GeForce RTX 4090", gpuCount: 1,
    image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404", cloud: "SECURE", diskGb: 50,
    ssh: { direct: { host: "203.0.113.10", port: 30222, username: "root" } } };
  return { calls,
    async listGpuTypes() { calls.push("catalog"); return [{ id: "NVIDIA GeForce RTX 4090", availability: "HIGH", secureHourlyUsd: .49 }]; },
    async listPods() { calls.push("list"); return []; },
    async findPodByJobId() { calls.push("find"); return null; },
    async createPod(input, { onBeforePost }) { await onBeforePost(); calls.push(["create", input]); return pod; },
    async getPod(id) { calls.push(["get", id]); return pod; }, ...overrides };
}

function proof(jobId) {
  return { uid: 1000, account: "agentcloud", workspace: `/home/agentcloud/agentcloud/${jobId}`,
    repo_sha: "a".repeat(40), gpu_device: "NVIDIA GeForce RTX 4090", nvidia_probe: "GPU 0: NVIDIA GeForce RTX 4090",
    workload_value: 4, correct: true, cpu_ms: 1.5, gpu_ms: .8, elapsed_ms: 2000,
    outputSha256: "b".repeat(64), evidenceRef: `ssh:${jobId}:${"b".repeat(64)}` };
}

test("Runpod preflight requires catalog price, availability, and no other managed Pod", async () => {
  const { db, job } = setup();
  const service = provider(job);
  assert.equal((await preflightRunpod(service, job)).hourlyUsd, .49);
  await assert.rejects(preflightRunpod(provider(job, { async listGpuTypes() {
    return [{ id: "NVIDIA GeForce RTX 4090", availability: "HIGH", secureHourlyUsd: null }];
  } }), job), /price unavailable/);
  await assert.rejects(preflightRunpod(provider(job, { async listPods() {
    return [{ name: "agentcloud-another-job", id: "other" }];
  } }), job), /Another managed Runpod Pod/);
  db.close();
});

test("changed Pod profile cannot be verified or marked ready", async () => {
  const { db, job } = setup();
  const service = provider(job, { async createPod(input, { onBeforePost }) { await onBeforePost(); return { id: "pod123", name: runpodPodName(input.jobId, input.expiresAt),
    gpuId: "NVIDIA A100", gpuCount: 1, image: input.image, cloud: input.cloud, diskGb: input.diskGb }; } });
  await assert.rejects(workOneRunpodJob(db, service, { workerId: "runpod-worker", connection: {},
    checkSshConfig() {}, checkCleanupGuard: async () => true, verify: async () => { throw new Error("must not verify"); } }),
  /no longer matches approved profile/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_gpu_verification").get().count, 0);
  db.close();
});

test("provider lookup failure before POST leaves no ambiguous create marker", async () => {
  const { db, job } = setup();
  const service = provider(job, { async createPod() { throw new Error("Runpod list unavailable"); } });
  await assert.rejects(workOneRunpodJob(db, service, { workerId: "runpod-worker", connection: {},
    checkSshConfig() {}, checkCleanupGuard: async () => true, verify: async () => {} }), /list unavailable/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_create_attempt").get().count, 0);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  db.close();
});

test("approved Runpod job reaches ready only after SSH and durable GPU proof", async () => {
  const { db, job } = setup();
  const service = provider(job);
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker",
    connection: { keyFile: "/private/key", knownHostsFile: "/private/hosts", publicKey: "ssh-ed25519 AAAA" },
    checkSshConfig() {}, checkCleanupGuard: async () => true, verify: async (approved, connection) => {
      assert.equal(approved.repo_url, "https://example.com/repo.git");
      assert.equal(connection.host, "203.0.113.10");
      return proof(job.id);
    } });
  assert.equal(result.state, "ready");
  assert.equal(db.prepare("SELECT repo_revision FROM run_box_job WHERE id = ?").get(job.id).repo_revision, "a".repeat(40));
  assert.equal(db.prepare("SELECT gpu_device FROM runpod_gpu_verification WHERE job_id = ?").get(job.id).gpu_device, "NVIDIA GeForce RTX 4090");
  assert.equal(service.calls.filter((call) => Array.isArray(call) && call[0] === "create").length, 1);
  assert.equal(service.calls.find((call) => Array.isArray(call) && call[0] === "create")[1].expiresAt,
    new Date(Math.floor((Date.parse(job.created_at) + job.max_duration_minutes * 60_000) / 1_000) * 1_000).toISOString());
  db.close();
});

test("missing SSH host pin leaves a visible retry without another Pod create", async () => {
  const { db, job } = setup();
  const service = provider(job);
  const settings = { workerId: "runpod-worker", connection: {}, checkSshConfig() {},
    checkCleanupGuard: async () => true,
    verify: async () => { throw new Error("Host key verification failed"); } };
  const first = await workOneRunpodJob(db, service, settings);
  assert.equal(first.state, "verifying");
  assert.equal(first.retry, true);
  assert.match(db.prepare("SELECT reason FROM runpod_connection_wait WHERE job_id = ?").get(job.id).reason, /pinned host key/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "verifying");
  await workOneRunpodJob(db, service, settings);
  assert.equal(service.calls.filter((call) => Array.isArray(call) && call[0] === "create").length, 1);
  assert.equal(db.prepare("SELECT attempts FROM run_box_job WHERE id = ?").get(job.id).attempts, 2);
  db.close();
});

test("missing independent cleanup guard blocks Runpod POST before catalog checks", async () => {
  const { db, job } = setup();
  const service = provider(job);
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker",
    verify: async () => { throw new Error("must not verify"); } });
  assert.equal(result.state, "allocating");
  assert.equal(result.retry, true);
  assert.deepEqual(service.calls, []);
  assert.match(db.prepare("SELECT reason FROM runpod_connection_wait WHERE job_id = ?").get(job.id).reason, /cleanup guard unavailable/);
  db.close();
});

test("guard losing freshness during catalog preflight blocks Runpod POST", async () => {
  const { db, job } = setup();
  const service = provider(job);
  let checks = 0;
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker", connection: {},
    checkSshConfig() {}, checkCleanupGuard: async () => ++checks === 1,
    verify: async () => { throw new Error("must not verify"); } });
  assert.equal(result.state, "allocating");
  assert.equal(result.retry, true);
  assert.equal(checks, 2);
  assert.equal(service.calls.some((call) => Array.isArray(call) && call[0] === "create"), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_create_attempt").get().count, 0);
  db.close();
});

test("stop request before allocation does not create a Pod", async () => {
  const { db, job } = setup();
  requestRunBoxStop(db, job.id, "owner");
  const service = provider(job);
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker", verify: async () => {} });
  assert.equal(result.state, "stopping");
  assert.equal(service.calls.length, 0);
  db.close();
});

function ed25519PublicKey() {
  const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url");
  const type = Buffer.from("ssh-ed25519");
  const length = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return `ssh-ed25519 ${Buffer.concat([length(type.length), type, length(raw.length), raw]).toString("base64")}`;
}

test("Runpod create pins a generated host key and verify trusts only that key", async () => {
  const { db, job } = setup();
  migrateSshKeys(db);
  db.prepare("INSERT INTO user VALUES ('employee-2', 1), ('outsider', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-2', 'org-1', 'member'), ('outsider', 'org-1', 'member')").run();
  db.prepare("INSERT INTO project_membership VALUES ('employee-2', 'project-1', 'member')").run();
  const ownerKey = ed25519PublicKey();
  const memberKey = ed25519PublicKey();
  registerSshKey(db, "employee-1", { label: "Owner laptop", publicKey: ownerKey });
  registerSshKey(db, "employee-2", { label: "Member laptop", publicKey: memberKey });
  registerSshKey(db, "outsider", { label: "Outsider", publicKey: ed25519PublicKey() });
  const operatorKey = ed25519PublicKey();
  const service = provider(job);
  let seen;
  const result = await workOneRunpodJob(db, service, { workerId: "runpod-worker",
    connection: { keyFile: "/private/key", publicKey: `${operatorKey} operator@worker` },
    checkSshConfig() {}, checkCleanupGuard: async () => true,
    verify: async (_job, connection) => {
      seen = { ...connection, knownHosts: readFileSync(connection.knownHostsFile, "utf8") };
      return proof(job.id);
    } });
  assert.equal(result.state, "ready");

  const [, input] = service.calls.find((call) => Array.isArray(call) && call[0] === "create");
  assert.match(input.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(input.cmd.slice(0, 2), ["bash", "-c"]);
  assert.match(input.cmd[2], /\/etc\/ssh\/ssh_host_ed25519_key/);
  assert.match(input.cmd[2], /exec \/start\.sh$/);
  assert.equal(input.env.AGENTCLOUD_OPERATOR_PUBLIC_KEY, operatorKey);
  assert.equal(Buffer.from(input.env.AGENTCLOUD_AUTHORIZED_KEYS_B64, "base64").toString(),
    `${operatorKey}\n${ownerKey}\n${memberKey}\n`);

  // The private key in the create env derives exactly the pinned public key.
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-worker-test-"));
  try {
    const file = path.join(directory, "key");
    writeFileSync(file, Buffer.from(input.env.AGENTCLOUD_SSH_HOST_KEY_B64, "base64"), { mode: 0o600 });
    const derived = execFileSync("ssh-keygen", ["-y", "-f", file], { encoding: "utf8" }).trim().split(" ").slice(0, 2).join(" ");
    assert.equal(derived, input.env.AGENTCLOUD_SSH_HOST_PUBLIC_KEY);
    assert.equal(seen.knownHosts, `[203.0.113.10]:30222 ${derived}\n`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assert.equal(existsSync(seen.knownHostsFile), false);
  assert.equal(seen.publicKey, operatorKey);
  assert.deepEqual(seen.authorizedKeys, [operatorKey, ownerKey, memberKey]);

  const endpoint = getRunBoxSshEndpoint(db, job.id);
  assert.equal(endpoint.username, RUNPOD_SSH_USER);
  assert.equal(endpoint.host, "203.0.113.10");
  assert.equal(endpoint.port, 30222);
  assert.equal(endpoint.hostPublicKey, input.env.AGENTCLOUD_SSH_HOST_PUBLIC_KEY);
  assert.deepEqual(endpoint.authorizedFingerprints, [sshFingerprint(ownerKey), sshFingerprint(memberKey)]);
  // The private host key is not persisted anywhere in the database.
  const dump = JSON.stringify(db.prepare("SELECT * FROM runpod_ssh_host_key").all()) +
    JSON.stringify(db.prepare("SELECT * FROM run_box_ssh_endpoint").all());
  assert.equal(dump.includes("PRIVATE KEY"), false);
  assert.equal(dump.includes(input.env.AGENTCLOUD_SSH_HOST_KEY_B64), false);
  db.close();
});

test("Runpod SSH config no longer requires an operator known_hosts file", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-worker-config-"));
  try {
    const keyFile = path.join(directory, "id_ed25519");
    writeFileSync(keyFile, "placeholder", { mode: 0o600 });
    validateRunpodSshConfig({ keyFile, publicKey: ed25519PublicKey() });
    assert.throws(() => validateRunpodSshConfig({ keyFile, publicKey: "ssh-rsa AAAA" }), /ed25519 public key/);
    assert.throws(() => validateRunpodSshConfig({ keyFile: path.join(directory, "missing"), publicKey: ed25519PublicKey() }), /unavailable/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("recovered Pod from an interrupted create keeps its recorded host key pin", async () => {
  const { db, job } = setup();
  migrateSshKeys(db);
  const pinned = ed25519PublicKey();
  const service = provider(job);
  const pod = await service.getPod("pod123");
  service.calls.length = 0;
  service.findPodByJobId = async () => { service.calls.push("find"); return pod; };
  const generateHostKey = async () => { throw new Error("must not generate a replacement key"); };
  const settings = { workerId: "runpod-worker", connection: { keyFile: "/private/key", publicKey: ed25519PublicKey() },
    checkSshConfig() {}, checkCleanupGuard: async () => true, generateHostKey,
    verify: async (_job, connection) => { assert.match(readFileSync(connection.knownHostsFile, "utf8"), new RegExp(pinned.split(" ")[1].replace(/\+/g, "\\+"))); return proof(job.id); } };
  // First (interrupted) attempt recorded this pin before its POST.
  const { migrateRunpodHostKeys } = await import("../lib/runpod-worker.mjs");
  migrateRunpodHostKeys(db);
  db.prepare("INSERT INTO runpod_ssh_host_key VALUES (?, ?, '[]', ?)").run(job.id, pinned, new Date().toISOString());
  const result = await workOneRunpodJob(db, service, settings);
  assert.equal(result.state, "ready");
  const [, input] = service.calls.find((call) => Array.isArray(call) && call[0] === "create");
  assert.equal(input.env, undefined);
  assert.equal(getRunBoxSshEndpoint(db, job.id).hostPublicKey, pinned);
  db.close();
});

test("an operator-pinned host key overrides the injected key only for its exact Pod address", async () => {
  const { operatorPinnedHostKey } = await import("../lib/runpod-worker.mjs");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/agentcloud-pin-`);
  const key = ed25519PublicKey();
  writeFileSync(`${dir}/known_hosts`, `[203.0.113.10]:30222 ${key}\n`);
  assert.equal(operatorPinnedHostKey(`${dir}/known_hosts`, "203.0.113.10", 30222), key);
  assert.equal(operatorPinnedHostKey(`${dir}/known_hosts`, "203.0.113.10", 30223), null);
  assert.equal(operatorPinnedHostKey(`${dir}/missing`, "203.0.113.10", 30222), null);
  assert.equal(operatorPinnedHostKey(undefined, "203.0.113.10", 30222), null);
});

test("budget RTX 4000 Ada profile preflights its own GPU and $0.50 ceiling", async () => {
  const job = { id: "11111111-1111-4111-8111-111111111111", provider: "runpod", profile_id: "runpod-rtx-4000-ada",
    max_duration_minutes: 60, created_at: new Date().toISOString() };
  const catalog = (price) => ({ async listGpuTypes() { return [{ id: "NVIDIA RTX 4000 Ada Generation", availability: "LOW", secureHourlyUsd: price }]; },
    async listPods() { return []; } });
  assert.deepEqual(await preflightRunpod(catalog(0.28), job), { hourlyUsd: 0.28 });
  await assert.rejects(preflightRunpod(catalog(0.6), job), /above \$0.5 ceiling/);
  await assert.rejects(preflightRunpod(catalog(0.28), { ...job, profile_id: "runpod-a100" }), /Unapproved Runpod profile/);
});
