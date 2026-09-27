import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { claimRunBoxJob, migrateRunBoxJobs, requestRunBoxStop, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { migrateSshKeys, registerSshKey, revokeSshKey } from "../lib/ssh-keys.mjs";
import { getRunBoxSshEndpoint, migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { registerContainerTemplate } from "../lib/container-templates.mjs";
import { NO_DEVICE_KEYS, reconcileDockerSandboxes, verifyDockerSandboxSsh,
  workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";

function devicePublicKey() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agentcloud-test-key-"));
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "device", "-f", path.join(dir, "key")]);
    return readFileSync(path.join(dir, "key.pub"), "utf8").trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function setup({ keys = 1, profileId = "local-docker-sandbox" } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  migrateRunBoxJobs(db);
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  db.prepare("INSERT INTO user VALUES ('owner-1', 1), ('outsider', 1)").run();
  db.prepare("INSERT INTO member VALUES ('owner-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1'), ('project-2', 'org-1')").run();
  for (let index = 0; index < keys; index += 1) registerSshKey(db, "owner-1", { label: `device ${index}`, publicKey: devicePublicKey() });
  registerSshKey(db, "outsider", { label: "not a member", publicKey: devicePublicKey() });
  return { db, job: decide(db, { profileId }).job };
}

function decide(db, overrides = {}) {
  return saveRunBoxDecision(db, { idempotencyKey: "idem-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "owner-1", organizationId: "org-1", projectRole: "owner", provider: "docker-local",
    profileId: "local-docker-sandbox", maxDurationMinutes: 60, ...overrides });
}

function fakeProvider(overrides = {}) {
  const containers = new Map();
  const calls = [];
  let sequence = 0;
  return { calls, containers,
    async find(jobId) { return containers.get(jobId) || null; },
    async create(input) {
      calls.push(["create", input]);
      if (containers.has(input.jobId)) return { containerId: containers.get(input.jobId).id, reused: true };
      sequence += 1;
      const id = String(sequence).padStart(12, "a");
      containers.set(input.jobId, { id, jobId: input.jobId, state: "running", authorizedKeys: input.authorizedKeys });
      return { containerId: id, reused: false };
    },
    async sshPort() { return 49222; },
    async remove(jobId) { calls.push(["remove", jobId]); return { removed: containers.delete(jobId) }; },
    async removeContainer(id) {
      calls.push(["removeContainer", id]);
      for (const [jobId, item] of containers) if (item.id === id) containers.delete(jobId);
    },
    async listManaged() { return [...containers.values()].map(({ id, jobId, state }) => ({ id, jobId, state })); },
    async replaceAuthorizedKeys(jobId, keys) {
      calls.push(["replaceAuthorizedKeys", jobId, keys]);
      containers.get(jobId).authorizedKeys = keys;
      return keys;
    },
    ...overrides };
}

test("revoked device key is removed from a ready sandbox, not just the connection API", async () => {
  const { db, job } = setup();
  const sandbox = fakeProvider();
  await workOneDockerSandboxJob(db, sandbox, { workerId: "worker", verify: passingVerify() });
  const key = db.prepare("SELECT id, public_key FROM employee_ssh_key WHERE user_id = 'owner-1'").get();
  assert.ok(sandbox.containers.get(job.id).authorizedKeys.includes(key.public_key));
  revokeSshKey(db, "owner-1", key.id);
  await reconcileDockerSandboxes(db, sandbox);
  assert.ok(!sandbox.containers.get(job.id).authorizedKeys.includes(key.public_key));
  db.close();
});

test("membership loss removes existing SSH access from a ready sandbox", async () => {
  const { db, job } = setup();
  const sandbox = fakeProvider();
  await workOneDockerSandboxJob(db, sandbox, { workerId: "worker", verify: passingVerify() });
  db.prepare("UPDATE member SET role = 'member' WHERE userId = 'owner-1'").run();
  const outcomes = await reconcileDockerSandboxes(db, sandbox);
  assert.equal(outcomes.find((item) => item.jobId === job.id)?.status, "access-updated");
  assert.deepEqual(sandbox.containers.get(job.id).authorizedKeys, []);
  db.close();
});

function passingVerify(calls = []) {
  return async (job, connection) => {
    calls.push(connection);
    return { account: "agentcloud", uid: 1000, workspace: "/home/agentcloud/workspace", repo_sha: null,
      remaining_keys: 1, verificationKeyRemoved: true, evidenceRef: `ssh:${job.id}:${"c".repeat(64)}` };
  };
}

test("docker-local migration upgrades a Runpod-era database and preserves rows and dependents", () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const check = "CHECK(provider IN ('ssh-host', 'aws-ec2', 'runpod'))";
  db.exec(`CREATE TABLE run_box_decision (
    id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    resource_request_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, employee_id TEXT NOT NULL,
    organization_id TEXT NOT NULL, project_role TEXT NOT NULL CHECK(project_role IN ('owner', 'member')),
    provider TEXT NOT NULL ${check}, profile_id TEXT,
    max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
    outcome TEXT NOT NULL CHECK(outcome IN ('approved', 'denied')), reason TEXT NOT NULL,
    policy_version TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE run_box_job (
    id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES run_box_decision(id),
    project_id TEXT NOT NULL, provider TEXT NOT NULL ${check}, profile_id TEXT,
    max_duration_minutes INTEGER NOT NULL CHECK(max_duration_minutes IN (60, 120)),
    state TEXT NOT NULL CHECK(state IN ('queued', 'allocating', 'connecting', 'verifying', 'ready', 'stopping', 'stopped', 'failed')),
    repo_url TEXT, repo_revision TEXT, provider_resource_id TEXT, worker_id TEXT, lease_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, stop_requested_at TEXT, stop_requested_by TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(provider, provider_resource_id));
    CREATE TABLE run_box_transition (id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES run_box_job(id), from_state TEXT, to_state TEXT NOT NULL,
      actor TEXT NOT NULL, reason TEXT, evidence_ref TEXT, created_at TEXT NOT NULL);
    CREATE TABLE runpod_create_attempt (job_id TEXT PRIMARY KEY REFERENCES run_box_job(id), attempted_at TEXT NOT NULL);`);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO run_box_decision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("decision-1", "idem-old",
    "hash", "request-old", "project-1", "owner-1", "org-1", "owner", "runpod", "runpod-rtx-4090", 60, "approved", "ok", "runbox-v1", now);
  db.prepare(`INSERT INTO run_box_job (id, decision_id, project_id, provider, profile_id, max_duration_minutes, state,
    repo_url, provider_resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "runpod-job", "decision-1", "project-1", "runpod", "runpod-rtx-4090", 60, "ready", "https://example.com/r.git", "pod-1", now, now);
  db.prepare("INSERT INTO run_box_transition (job_id, to_state, actor, created_at) VALUES ('runpod-job', 'ready', 'w', ?)").run(now);
  db.prepare("INSERT INTO runpod_create_attempt VALUES ('runpod-job', ?)").run(now);
  migrateRunBoxJobs(db);
  migrateRunBoxJobs(db);
  for (const table of ["run_box_decision", "run_box_job"])
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table).sql, /'docker-local'/);
  assert.equal(db.prepare("SELECT provider_resource_id FROM run_box_job WHERE id = 'runpod-job'").get().provider_resource_id, "pod-1");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM run_box_transition").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM runpod_create_attempt").get().count, 1);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(decide(db).job.provider, "docker-local");
  db.close();
});

test("docker-local decisions use the server profile, need no repository, and allow one active box per project", () => {
  const { db, job } = setup();
  assert.equal(job.provider, "docker-local");
  assert.equal(job.profile_id, "local-docker-sandbox");
  assert.equal(job.repo_url, null);
  assert.throws(() => decide(db, { idempotencyKey: "idem-x", resourceRequestId: "request-x", profileId: "runpod-rtx-4090" }),
    /Invalid local Docker sandbox profile/);
  assert.throws(() => decide(db, { idempotencyKey: "idem-2", resourceRequestId: "request-2" }), /already active for this project/);
  assert.equal(decide(db, { idempotencyKey: "idem-3", resourceRequestId: "request-3", projectId: "project-2" }).job.state, "queued");
  assert.equal(decide(db, { idempotencyKey: "idem-4", resourceRequestId: "request-4", projectRole: "member" }).job, null);
  db.close();
});

test("worker reaches ready with pinned endpoint, member keys plus a one-time verifier key, and no private key stored", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  const verifyCalls = [];
  const result = await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify(verifyCalls) });
  assert.equal(result.state, "ready");
  const stored = db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(job.id);
  assert.equal(stored.provider_resource_id, `agentcloud-sandbox-${job.id}`);
  const endpoint = getRunBoxSshEndpoint(db, job.id);
  assert.equal(endpoint.host, "127.0.0.1");
  assert.equal(endpoint.port, 49222);
  assert.equal(endpoint.username, "agentcloud");
  assert.match(endpoint.hostPublicKey, /^ssh-ed25519 /);
  const memberKeys = db.prepare("SELECT public_key, fingerprint FROM employee_ssh_key WHERE user_id = 'owner-1'").all();
  assert.deepEqual(endpoint.authorizedFingerprints, memberKeys.map((key) => key.fingerprint));
  const created = provider.calls.find((call) => call[0] === "create")[1];
  assert.equal(created.authorizedKeys.length, 2);
  assert.equal(created.authorizedKeys[0], memberKeys[0].public_key);
  assert.equal(created.authorizedKeys[1], verifyCalls[0].verificationPublicKey);
  const outsider = db.prepare("SELECT public_key FROM employee_ssh_key WHERE user_id = 'outsider'").get().public_key;
  assert.ok(!created.authorizedKeys.includes(outsider));
  assert.match(Buffer.from(created.hostPrivateKeyB64, "base64").toString(), /BEGIN OPENSSH PRIVATE KEY/);
  const dump = JSON.stringify(db.prepare("SELECT * FROM run_box_job").all()) +
    JSON.stringify(db.prepare("SELECT * FROM run_box_transition").all()) +
    JSON.stringify(db.prepare("SELECT * FROM run_box_ssh_endpoint").all());
  assert.doesNotMatch(dump, /PRIVATE KEY/);
  assert.throws(() => readFileSync(verifyCalls[0].keyFile), /ENOENT/, "ephemeral key directory is deleted");
  assert.equal(await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() }), null);
  assert.equal(provider.containers.size, 1);
  db.close();
});

test("worker runs an imported template by immutable image ID", async () => {
  const { db, job } = setup({ profileId: "local-template:python-agent" });
  const imageId = `sha256:${"a".repeat(64)}`;
  registerContainerTemplate(db, { id: "python-agent", label: "Python agent", imageRef: "example/agent:1",
    imageId, source: "registry" });
  const provider = fakeProvider();
  const result = await workOneDockerSandboxJob(db, provider, { verify: passingVerify() });
  assert.equal(result.state, "ready");
  assert.equal(provider.calls.find((call) => call[0] === "create")[1].imageId, imageId);
  db.close();
});

test("worker never allocates a missing imported template", async () => {
  const { db, job } = setup({ profileId: "local-template:missing" });
  const provider = fakeProvider();
  await assert.rejects(() => workOneDockerSandboxJob(db, provider, { verify: passingVerify() }),
    /template is unavailable/);
  assert.equal(provider.calls.filter((call) => call[0] === "create").length, 0);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  db.close();
});

test("zero registered device keys fails the job with a clear reason and creates nothing", async () => {
  const { db, job } = setup({ keys: 0 });
  const provider = fakeProvider();
  await assert.rejects(workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() }),
    new RegExp(NO_DEVICE_KEYS.replace(/[.;]/g, "\\$&")));
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  assert.equal(db.prepare("SELECT reason FROM run_box_transition WHERE job_id = ? AND to_state = 'failed'").get(job.id).reason,
    NO_DEVICE_KEYS);
  assert.equal(provider.calls.filter((call) => call[0] === "create").length, 0);
  // A failed sandbox holds nothing, so the owner may start another.
  assert.equal(decide(db, { idempotencyKey: "idem-5", resourceRequestId: "request-5" }).job.state, "queued");
  db.close();
});

test("failed verification fails the job and removes its container", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await assert.rejects(workOneDockerSandboxJob(db, provider, { workerId: "docker-worker",
    verify: async () => { throw new Error("Sandbox host key did not match the pinned key"); } }), /pinned key/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "failed");
  assert.equal(provider.containers.size, 0);
  db.close();
});

test("stop request removes the container and records stopped with absence evidence", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() });
  requestRunBoxStop(db, job.id, "owner-1");
  const result = await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker-2", verify: passingVerify() });
  assert.equal(result.state, "stopped");
  assert.equal(result.evidenceRef, `docker:removed:agentcloud-sandbox-${job.id}:absent`);
  assert.equal(provider.containers.size, 0);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "stopped");
  db.close();
});

test("a failed removal keeps the stop pending instead of failing the job", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() });
  requestRunBoxStop(db, job.id, "owner-1");
  const broken = { ...provider, async remove() { throw new Error("docker rm failed: daemon unavailable"); } };
  await assert.rejects(workOneDockerSandboxJob(db, broken, { workerId: "docker-worker" }), /daemon unavailable/);
  assert.equal(db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(job.id).state, "ready");
  assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker" })).state, "stopped");
  db.close();
});

test("a resumed allocation recreates one container under the stable name", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  claimRunBoxJob(db, "crashed-worker", new Date(Date.now() - 10 * 60_000), 60_000, "docker-local");
  provider.containers.set(job.id, { id: "deadbeefdead", jobId: job.id, state: "running", authorizedKeys: [] });
  const result = await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() });
  assert.equal(result.state, "ready");
  assert.equal(provider.containers.size, 1);
  assert.notEqual(provider.containers.get(job.id).id, "deadbeefdead");
  db.close();
});

test("reconciler expires overdue sandboxes and removes containers of failed, stopped, or unknown jobs", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() });
  provider.containers.set("11111111-1111-1111-1111-111111111111",
    { id: "0123456789ab", jobId: "11111111-1111-1111-1111-111111111111", state: "running" });
  const later = new Date(Date.now() + 61 * 60_000);
  const outcomes = await reconcileDockerSandboxes(db, provider, { now: later });
  assert.ok(outcomes.some((item) => item.jobId === job.id && item.status === "expired"));
  assert.ok(outcomes.some((item) => item.containerId === "0123456789ab" && item.status === "removed" && item.orphan));
  assert.ok(db.prepare("SELECT stop_requested_at FROM run_box_job WHERE id = ?").get(job.id).stop_requested_at);
  assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker" })).state, "stopped");
  assert.equal(provider.containers.size, 0);
  db.close();
});

test("reconciler requests stop when a ready sandbox container disappears", async () => {
  const { db, job } = setup();
  const provider = fakeProvider();
  await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker", verify: passingVerify() });
  provider.containers.clear();
  const outcomes = await reconcileDockerSandboxes(db, provider);
  assert.deepEqual(outcomes, [{ jobId: job.id, status: "container-lost" }]);
  assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "docker-worker" })).state, "stopped");
  db.close();
});

test("SSH verifier retries while sshd starts and requires the verifier key to be denied afterwards", async () => {
  const job = { id: "22222222-2222-2222-2222-222222222222", repo_url: null, repo_revision: null };
  const connection = { host: "127.0.0.1", port: 40000, verificationPublicKey: devicePublicKey().split(" ").slice(0, 2).join(" ") };
  const evidence = 'AGENTCLOUD_EVIDENCE={"account":"agentcloud","uid":1000,"workspace":"/home/agentcloud/workspace","repo_sha":"","remaining_keys":1}\n';
  const replies = [{ code: 255, stdout: "", stderr: "kex_exchange_identification: Connection closed" },
    { code: 0, stdout: evidence, stderr: "" },
    { code: 255, stdout: "", stderr: "agentcloud@127.0.0.1: Permission denied (publickey)." }];
  const proof = await verifyDockerSandboxSsh(job, connection, { run: async () => replies.shift(), delayMs: 1 });
  assert.equal(proof.verificationKeyRemoved, true);
  assert.match(proof.evidenceRef, /^ssh:22222222-2222-2222-2222-222222222222:[a-f0-9]{64}$/);
  const stillAccepted = [{ code: 0, stdout: evidence, stderr: "" }, { code: 0, stdout: "", stderr: "" }];
  await assert.rejects(verifyDockerSandboxSsh(job, connection, { run: async () => stillAccepted.shift() }),
    /still accepts the worker verification key/);
  await assert.rejects(verifyDockerSandboxSsh(job, connection, { run: async () =>
    ({ code: 255, stdout: "", stderr: "Host key verification failed." }) }), /did not match the pinned key/);
});
