import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getCodexRunnerKey, codexRunnerKeyPath } from "../lib/codex-runner-key.mjs";
import { migrateRunBoxJobs, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { setAwsApproval } from "../lib/aws-organization-approval.mjs";
import { migrateSshKeys, registerSshKey, sshFingerprint } from "../lib/ssh-keys.mjs";
import { getRunBoxSshEndpoint, migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { getAgentCheck, getWorkspacePath, listCleanupSteps, CLEANUP_STEPS } from "../lib/agent-check.mjs";
import { createAwsCpuAgentCleanup, reconcileAwsCpuSshAccess, workOneAwsCpuJob } from "../lib/aws-cpu-worker.mjs";
import { CODEX_VERSION } from "../lib/aws-cpu-provider.mjs";
import { reconcileDockerSandboxes, workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";
import { reconcileRunpodSshAccess, workOneRunpodJob } from "../lib/runpod-worker.mjs";
import { runpodPodName } from "../lib/runpod-provider.mjs";
import { migrateRunpodEvidence } from "../lib/runpod-evidence.mjs";
import { migrateRunpodCleanup } from "../lib/runpod-reconcile.mjs";
import { ed25519PublicKey } from "./ssh-key-fixture.mjs";

const scratch = mkdtempSync(path.join(os.tmpdir(), "codex-runner-key-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const runnerPublic = ed25519PublicKey();
const runnerKey = { publicKey: runnerPublic, fingerprint: sshFingerprint(runnerPublic) };

test("runner key is generated once per install with private permissions", async () => {
  const dataDir = path.join(scratch, "data");
  const [first, second] = await Promise.all([getCodexRunnerKey({ dataDir }), getCodexRunnerKey({ dataDir })]);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.keyFile, codexRunnerKeyPath(dataDir));
  assert.equal(statSync(path.dirname(first.keyFile)).mode & 0o777, 0o700);
  assert.equal(statSync(first.keyFile).mode & 0o777, 0o600);
  assert.equal(statSync(`${first.keyFile}.pub`).mode & 0o777, 0o600);
  assert.equal(sshFingerprint(first.publicKey), first.fingerprint);
  assert.equal(JSON.stringify(first).includes("PRIVATE KEY"), false);
  assert.match(readFileSync(first.keyFile, "utf8"), /OPENSSH PRIVATE KEY/);
  assert.equal((await getCodexRunnerKey({ dataDir })).fingerprint, first.fingerprint);
});

function tables(db) {
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE organization (id TEXT PRIMARY KEY);`);
  migrateRunBoxJobs(db); migrateSshKeys(db); migrateRunBoxSsh(db);
  db.prepare("INSERT INTO user VALUES ('employee-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('employee-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
  db.prepare("INSERT INTO organization VALUES ('org-1')").run();
}
const decision = (provider, profileId, repoUrl = "https://github.com/example/repo.git") => ({
  idempotencyKey: `d-${provider}`, resourceRequestId: `r-${provider}`, projectId: "project-1", employeeId: "employee-1",
  organizationId: "org-1", projectRole: "owner", provider, profileId, maxDurationMinutes: 60, repoUrl });

// aws-cpu ---------------------------------------------------------------------
const operatorKey = ed25519PublicKey();
const keyFile = path.join(scratch, "operator");
writeFileSync(keyFile, "unused\n", { mode: 0o600 });
const connection = { keyFile, publicKey: operatorKey };
const instanceId = "i-0abcdef0123456789";
function awsProvider() {
  const calls = []; const hostKey = ed25519PublicKey();
  return { calls, hostKey,
    async identifyWorker() {}, async allocate(_job, options) { calls.push(["allocate", options]); return { InstanceId: instanceId }; },
    async inspect() { return { InstanceId: instanceId, State: { Name: "running" }, PublicIpAddress: "198.51.100.20", LaunchTime: new Date().toISOString() }; },
    async authorizeSsh(_job, cidr) { return { ruleId: "sgr-1", cidr }; },
    async readHostKey() { return { state: "ready", hostPublicKey: hostKey, commandId: "c" }; },
    async checkAgent(job) { return { account: "agentcloud", uid: 1001, workspace: `/home/agentcloud/agentcloud/${job.id}/repo`, repo_sha: "a".repeat(40),
      codex: `codex-cli ${CODEX_VERSION}`, tmux: "tmux 3.2a", git: "git version 2.47.1", node: "v22.23.3", outputSha256: "b".repeat(64) }; } };
}

async function readyAwsCpu(profileId = "aws-cpu") {
  const db = new Database(":memory:"); tables(db);
  setAwsApproval(db, { organizationId: "org-1", approved: true, maxRunMinutes: 120, monthlyMinutes: 1200, actorId: "platform-admin" });
  const member = ed25519PublicKey();
  registerSshKey(db, "employee-1", { label: "Mac", publicKey: member });
  const { job } = saveRunBoxDecision(db, decision("aws-ec2", profileId));
  const provider = awsProvider();
  if (profileId.startsWith("aws-gpu-")) {
    const check = provider.checkAgent;
    provider.checkAgent = async (target) => ({ ...await check(target), gpus: [{ name: "Tesla T4", memoryMiB: 15360 }] });
  }
  let result;
  for (let cycle = 0; cycle < 5 && result?.state !== "ready"; cycle++)
    result = await workOneAwsCpuJob(db, provider, { workerId: "w", connection, sshSourceCidr: "203.0.113.7/32", runnerKey });
  assert.equal(result.state, "ready");
  return { db, job, provider, member };
}

test("aws-cpu installs the runner key, tags its fingerprint, and records Codex readiness and workspace", async () => {
  const { db, job, provider, member } = await readyAwsCpu();
  const allocate = provider.calls.find((call) => call[0] === "allocate")[1];
  assert.deepEqual(new Set(allocate.authorizedKeys), new Set([operatorKey, member, runnerPublic]));
  const endpoint = getRunBoxSshEndpoint(db, job.id);
  assert.deepEqual(endpoint.authorizedFingerprints, [sshFingerprint(member)]);
  assert.equal(endpoint.serverFingerprint, runnerKey.fingerprint);
  assert.equal(getAgentCheck(db, job.id).state, "ready");
  assert.equal(getWorkspacePath(db, job.id), `/home/agentcloud/agentcloud/${job.id}/repo`);
  db.close();
});

test("aws-cpu access reconcile removes revoked member keys and keeps operator and runner keys", async () => {
  const { db, job } = await readyAwsCpu();
  db.prepare("UPDATE employee_ssh_key SET revoked_at = ?").run(new Date().toISOString());
  let installed;
  const outcomes = await reconcileAwsCpuSshAccess(db, connection, { runnerKey, checkConnection: () => operatorKey,
    run: async (target, script) => {
      assert.equal(target.host, "198.51.100.20"); assert.match(readFileSync(target.knownHostsFile, "utf8"), /^198\.51\.100\.20 ssh-ed25519 /);
      const encoded = script.match(/printf '%s' '([^']*)' \| base64 -d/)[1];
      installed = Buffer.from(encoded, "base64").toString();
      return { code: 0, stdout: `${encoded}\n` };
    } });
  assert.equal(outcomes[0].status, "access-updated");
  assert.equal(installed, `${operatorKey}\n${runnerPublic}\n`);
  const endpoint = getRunBoxSshEndpoint(db, job.id);
  assert.deepEqual(endpoint.authorizedFingerprints, []);
  assert.equal(endpoint.serverFingerprint, runnerKey.fingerprint);
  // Without this install's runner key the server key is dropped from the box and the record.
  registerSshKey(db, "employee-1", { label: "New Mac", publicKey: ed25519PublicKey() });
  await reconcileAwsCpuSshAccess(db, connection, { checkConnection: () => operatorKey,
    run: async (_target, script) => { const encoded = script.match(/printf '%s' '([^']*)' \| base64 -d/)[1];
      installed = Buffer.from(encoded, "base64").toString(); return { code: 0, stdout: encoded }; } });
  assert.equal(installed.includes(runnerPublic), false);
  assert.equal(getRunBoxSshEndpoint(db, job.id).serverFingerprint, null);
  // An unverifiable replacement stops the environment instead of leaving stale access.
  db.prepare("UPDATE employee_ssh_key SET revoked_at = ?").run(new Date().toISOString());
  const failed = await reconcileAwsCpuSshAccess(db, connection, { checkConnection: () => operatorKey, run: async () => ({ code: 255, stdout: "" }) });
  assert.equal(failed[0].status, "access-update-failed");
  assert.ok(db.prepare("SELECT stop_requested_at FROM run_box_job WHERE id = ?").get(job.id).stop_requested_at);
  db.close();
});

test("aws-cpu teardown cleanup removes Codex auth over pinned SSH and never throws", async () => {
  const { db, job } = await readyAwsCpu();
  const stored = db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(job.id);
  const cleanup = createAwsCpuAgentCleanup(db, connection, { run: async (_target, script) => {
    assert.match(script, /auth\.json/);
    return { code: 0, stdout: CLEANUP_STEPS.map(([step]) => `AGENTCLOUD_CLEANUP ${step} ok`).join("\n") };
  } });
  const result = await cleanup(stored);
  assert.equal(result.reached, true);
  assert.ok(listCleanupSteps(db, job.id).some((step) => step.step === "remove-codex-auth" && step.ok));
  const offline = createAwsCpuAgentCleanup(db, connection, { run: async () => { throw new Error("offline"); } });
  assert.equal((await offline(stored)).reached, false);
  assert.equal(await cleanup({ ...stored, profile_id: null }), null, "GPU boxes are untouched");
  db.close();
});

// docker-local ----------------------------------------------------------------
test("docker-local installs the runner key next to member keys and keeps it through access reconcile", async () => {
  const db = new Database(":memory:"); tables(db);
  const member = ed25519PublicKey();
  registerSshKey(db, "employee-1", { label: "Mac", publicKey: member });
  const { job } = saveRunBoxDecision(db, { ...decision("docker-local", "local-docker-sandbox"), repoUrl: undefined });
  const containers = new Map(); const replaced = [];
  const provider = {
    async find(jobId) { return containers.get(jobId) || null; },
    async create(input) { containers.set(input.jobId, { id: "a".repeat(12), jobId: input.jobId, state: "running", authorizedKeys: input.authorizedKeys }); return { containerId: "a".repeat(12) }; },
    async sshPort() { return 49222; }, async remove() {}, async removeContainer() {},
    async listManaged() { return [...containers.values()]; },
    async replaceAuthorizedKeys(jobId, keys) { replaced.push(keys); containers.get(jobId).authorizedKeys = keys; return keys; },
  };
  const result = await workOneDockerSandboxJob(db, provider, { workerId: "w", runnerKey,
    verify: async (fresh) => ({ account: "agentcloud", uid: 1000, workspace: "/home/agentcloud/workspace", repo_sha: null,
      remaining_keys: 2, verificationKeyRemoved: true, evidenceRef: `ssh:${fresh.id}:${"c".repeat(64)}`,
      agentCheck: { ok: true, version: "0.157.1", reason: null } }) });
  assert.equal(result.state, "ready");
  const keys = containers.get(job.id).authorizedKeys;
  assert.equal(keys[0], member); assert.equal(keys[1], runnerPublic); assert.equal(keys.length, 3);
  assert.equal(getRunBoxSshEndpoint(db, job.id).serverFingerprint, runnerKey.fingerprint);
  assert.deepEqual(getRunBoxSshEndpoint(db, job.id).authorizedFingerprints, [sshFingerprint(member)]);
  db.prepare("UPDATE employee_ssh_key SET revoked_at = ?").run(new Date().toISOString());
  await reconcileDockerSandboxes(db, provider, { runnerKey });
  assert.deepEqual(replaced.at(-1), [runnerPublic]);
  assert.equal(getRunBoxSshEndpoint(db, job.id).serverFingerprint, runnerKey.fingerprint);
  db.close();
});

// runpod ------------------------------------------------------------------------
test("runpod installs the runner key at start and bootstrap and keeps it through access reconcile", async () => {
  const db = new Database(":memory:"); tables(db); migrateRunpodEvidence(db); migrateRunpodCleanup(db);
  const member = ed25519PublicKey();
  registerSshKey(db, "employee-1", { label: "Mac", publicKey: member });
  const { job } = saveRunBoxDecision(db, decision("runpod", "runpod-rtx-4090"));
  const expiresAt = new Date(Math.floor((Date.parse(job.created_at) + 60 * 60_000) / 1_000) * 1_000);
  const pod = { id: "pod123", name: runpodPodName(job.id, expiresAt), status: "RUNNING", gpuId: "NVIDIA GeForce RTX 4090", gpuCount: 1,
    image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404", cloud: "SECURE", diskGb: 50,
    ssh: { direct: { host: "203.0.113.10", port: 30222, username: "root" } } };
  let created; let seen;
  const service = {
    async listGpuTypes() { return [{ id: "NVIDIA GeForce RTX 4090", availability: "HIGH", secureHourlyUsd: .49 }]; },
    async listPods() { return []; }, async findPodByJobId() { return null; },
    async createPod(input, { onBeforePost }) { await onBeforePost(); created = input; return pod; },
    async getPod() { return pod; } };
  const result = await workOneRunpodJob(db, service, { workerId: "w", connection: { keyFile: "/private/key", publicKey: operatorKey },
    checkSshConfig() {}, checkCleanupGuard: async () => true, runnerKey,
    verify: async (_job, conn) => { seen = conn; return { uid: 1000, account: "agentcloud", workspace: `/home/agentcloud/agentcloud/${job.id}`,
      repo_sha: "a".repeat(40), gpu_device: "NVIDIA GeForce RTX 4090", nvidia_probe: "GPU 0: NVIDIA GeForce RTX 4090", workload_value: 4, correct: true,
      cpu_ms: 1.5, gpu_ms: .8, elapsed_ms: 2000, outputSha256: "b".repeat(64), evidenceRef: `ssh:${job.id}:${"b".repeat(64)}` }; } });
  assert.equal(result.state, "ready");
  assert.equal(Buffer.from(created.env.AGENTCLOUD_AUTHORIZED_KEYS_B64, "base64").toString(), `${operatorKey}\n${member}\n${runnerPublic}\n`);
  assert.deepEqual(seen.authorizedKeys, [operatorKey, member, runnerPublic]);
  const endpoint = getRunBoxSshEndpoint(db, job.id);
  assert.deepEqual(endpoint.authorizedFingerprints, [sshFingerprint(member)]);
  assert.equal(endpoint.serverFingerprint, runnerKey.fingerprint);
  db.prepare("UPDATE employee_ssh_key SET revoked_at = ?").run(new Date().toISOString());
  let installed;
  await reconcileRunpodSshAccess(db, service, { keyFile: "/private/key", publicKey: operatorKey }, { runnerKey,
    run: async (_c, _account, script) => { const encoded = script.match(/printf '%s' '([^']*)' \| base64 -d/)[1];
      installed = Buffer.from(encoded, "base64").toString(); return `${encoded}\n`; } });
  assert.equal(installed, `${runnerPublic}\n`);
  assert.equal(getRunBoxSshEndpoint(db, job.id).serverFingerprint, runnerKey.fingerprint);
  db.close();
});

// Sized AWS environments: other catalog machines get the same member key revocation and
// teardown cleanup as aws-cpu.
for (const profileId of ["aws-cpu-large", "aws-gpu-t4"]) {
  test(`${profileId} access reconcile replaces member keys and cleanup reaches the box, like aws-cpu`, async () => {
    const { db, job } = await readyAwsCpu(profileId);
    db.prepare("UPDATE employee_ssh_key SET revoked_at = ?").run(new Date().toISOString());
    let installed;
    const outcomes = await reconcileAwsCpuSshAccess(db, connection, { runnerKey, checkConnection: () => operatorKey,
      run: async (_target, script) => {
        const encoded = script.match(/printf '%s' '([^']*)' \| base64 -d/)[1];
        installed = Buffer.from(encoded, "base64").toString();
        return { code: 0, stdout: `${encoded}\n` };
      } });
    assert.deepEqual(outcomes.map((item) => [item.jobId, item.status]), [[job.id, "access-updated"]]);
    assert.equal(installed, `${operatorKey}\n${runnerPublic}\n`);
    const stored = db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(job.id);
    const cleanup = createAwsCpuAgentCleanup(db, connection, { run: async () =>
      ({ code: 0, stdout: CLEANUP_STEPS.map(([step]) => `AGENTCLOUD_CLEANUP ${step} ok`).join("\n") }) });
    assert.equal((await cleanup(stored)).reached, true);
    db.close();
  });
}
