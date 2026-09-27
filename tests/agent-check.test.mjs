import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { AGENT_CHECK_SCRIPT, CLEANUP_SCRIPT, CODEX_VERSION, codexConfigScript, evaluateAgentCheckOutput, getAgentCheck,
  getWorkspacePath, listCleanupSteps, migrateAgentCheck, parseCleanupOutput, recordAgentCheck,
  recordCleanupStep, recordWorkspacePath, runAgentCleanup } from "../lib/agent-check.mjs";
import { claimRunBoxJob, migrateRunBoxJobs, recordRunBoxAllocation, requestRunBoxStop,
  saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { migrateSshKeys, registerSshKey } from "../lib/ssh-keys.mjs";
import { migrateRunBoxSsh, recordRunBoxSshEndpoint } from "../lib/run-box-ssh.mjs";
import { reconcileDockerSandboxes, sandboxWorkspacePath, verifyDockerSandboxSsh, workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";
import { checkRunpodAgent, createRunpodAgentCleanup, RUNPOD_START_SCRIPT, workOneRunpodJob } from "../lib/runpod-worker.mjs";
import { migrateRunpodEvidence } from "../lib/runpod-evidence.mjs";
import { migrateRunpodCleanup, reconcileRunpodJobs } from "../lib/runpod-reconcile.mjs";
import { runpodPodName } from "../lib/runpod-provider.mjs";

const codexLine = (code, output) => `AGENTCLOUD_CODEX=${code}:${Buffer.from(output).toString("base64")}`;
const agentOutput = (version = CODEX_VERSION, store = "file") =>
  `${codexLine(0, `codex-cli ${version}\n`)}\nAGENTCLOUD_TMUX=1\nAGENTCLOUD_CODEX_STORE=${store}\n`;
const cleanupOutput = (fail = []) => ["codex-logout", "remove-codex-auth", "remove-scratch", "verify-auth-absent"]
  .map((step) => `AGENTCLOUD_CLEANUP ${step} ${fail.includes(step) ? "fail" : "ok"}`).join("\n") + "\n";

function ed25519PublicKey() {
  const raw = Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x, "base64url");
  const type = Buffer.from("ssh-ed25519");
  const length = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  return `ssh-ed25519 ${Buffer.concat([length(type.length), type, length(raw.length), raw]).toString("base64")}`;
}

function authTables(db) {
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  db.prepare("INSERT INTO user VALUES ('owner-1', 1)").run();
  db.prepare("INSERT INTO member VALUES ('owner-1', 'org-1', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('project-1', 'org-1')").run();
}

function dockerSetup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  authTables(db);
  migrateRunBoxJobs(db);
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  registerSshKey(db, "owner-1", { label: "laptop", publicKey: ed25519PublicKey() });
  const { job } = saveRunBoxDecision(db, { idempotencyKey: "idem-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "owner-1", organizationId: "org-1", projectRole: "owner", provider: "docker-local",
    profileId: "local-docker-sandbox", maxDurationMinutes: 60 });
  return { db, job };
}

// Fake docker provider that records the order of cleanup and removal calls.
function fakeProvider({ cleanup = async () => ({ code: 0, stdout: cleanupOutput() }) } = {}) {
  const containers = new Map();
  const calls = [];
  let sequence = 0;
  return { calls, containers,
    async find(jobId) { return containers.get(jobId) || null; },
    async create(input) {
      sequence += 1;
      const id = String(sequence).padStart(12, "a");
      containers.set(input.jobId, { id, jobId: input.jobId, state: "running" });
      return { containerId: id, reused: false };
    },
    async sshPort() { return 49222; },
    async runAsAgent(id, script) { calls.push(["runAsAgent", id, script]); return cleanup(id, script); },
    async remove(jobId) { calls.push(["remove", jobId]); return { removed: containers.delete(jobId) }; },
    async removeContainer(id) {
      calls.push(["removeContainer", id]);
      for (const [jobId, item] of containers) if (item.id === id) containers.delete(jobId);
    },
    async listManaged() { return [...containers.values()]; } };
}

function verifyWith({ agentCheck, repoSha = null } = {}) {
  return async (job) => ({ account: "agentcloud", uid: 1000, workspace: "/home/agentcloud/workspace", repo_sha: repoSha,
    remaining_keys: 1, verificationKeyRemoved: true, evidenceRef: `ssh:${job.id}:${"c".repeat(64)}`,
    ...(agentCheck === undefined ? {} : { agentCheck }) });
}

test("codex --version output is ok only for the exact pinned version", () => {
  assert.equal(CODEX_VERSION, "0.157.1");
  assert.deepEqual(evaluateAgentCheckOutput(agentOutput()), { ok: true, version: "0.157.1", reason: null, tmux: true });
  const older = evaluateAgentCheckOutput(agentOutput("0.150.0"));
  assert.equal(older.ok, false);
  assert.equal(older.version, "0.150.0");
  assert.match(older.reason, /0\.150\.0 is installed; 0\.157\.1 is required/);
  assert.equal(evaluateAgentCheckOutput(agentOutput("0.157.10")).ok, false);
  assert.deepEqual(evaluateAgentCheckOutput(`${codexLine(127, "bash: codex: command not found")}\nAGENTCLOUD_TMUX=0\n`),
    { ok: false, version: null, reason: "Codex is not installed on PATH", tmux: false });
  assert.match(evaluateAgentCheckOutput(codexLine(1, "error")).reason, /exit 1/);
  assert.equal(evaluateAgentCheckOutput("").reason, "Codex version check did not run");
  assert.equal(evaluateAgentCheckOutput(`${agentOutput()}${agentOutput()}`).ok, false, "ambiguous output is refused");
  assert.match(AGENT_CHECK_SCRIPT, /codex --version/);
  const keyring = evaluateAgentCheckOutput(agentOutput(CODEX_VERSION, "other"));
  assert.equal(keyring.ok, false);
  assert.match(keyring.reason, /credential store is not set to file/);
});

test("Codex config forces the file credential store, merge-safe, 0600, in both box bootstraps", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "agentcloud-codex-home-"));
  try {
    const user = execFileSync("id", ["-un"], { encoding: "utf8" }).trim();
    const group = execFileSync("id", ["-gn"], { encoding: "utf8" }).trim();
    const script = `set -euo pipefail\n${codexConfigScript(home, user, group)}`;
    execFileSync("bash", ["-c", script]);
    const config = path.join(home, ".codex", "config.toml");
    assert.equal(readFileSync(config, "utf8"), 'cli_auth_credentials_store = "file"\n');
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(home, ".codex")).mode & 0o777, 0o700);
    // An existing config keeps its other settings; a conflicting store is replaced; reruns are stable.
    writeFileSync(config, 'model = "gpt-5"\ncli_auth_credentials_store = "keyring"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
    execFileSync("bash", ["-c", script]);
    execFileSync("bash", ["-c", script]);
    assert.equal(readFileSync(config, "utf8"),
      'cli_auth_credentials_store = "file"\nmodel = "gpt-5"\n\n[projects."/x"]\ntrust_level = "trusted"\n');
  } finally { rmSync(home, { recursive: true, force: true }); }
  const entrypoint = readFileSync(new URL("../infra/sandbox/entrypoint.sh", import.meta.url), "utf8");
  assert.ok(entrypoint.includes(codexConfigScript()), "docker-local entrypoint writes the same config");
  assert.ok(RUNPOD_START_SCRIPT.includes(codexConfigScript().trimEnd()), "Runpod start script writes the same config");
  assert.ok(RUNPOD_START_SCRIPT.indexOf("config.toml") < RUNPOD_START_SCRIPT.indexOf("exec /start.sh"));
});

test("agent-check migration is idempotent and preserves recorded rows", () => {
  const db = new Database(":memory:");
  migrateAgentCheck(db);
  recordAgentCheck(db, "job-1", { agent: "codex", ok: true, version: "0.157.1" });
  recordCleanupStep(db, "job-1", "remove-codex-auth", true);
  recordWorkspacePath(db, "job-1", "/home/agentcloud/workspace/repo");
  migrateAgentCheck(db);
  assert.equal(getAgentCheck(db, "job-1").state, "ready");
  assert.deepEqual(listCleanupSteps(db, "job-1").map(({ step, ok }) => [step, ok]), [["remove-codex-auth", true]]);
  assert.equal(getWorkspacePath(db, "job-1"), "/home/agentcloud/workspace/repo");
  assert.deepEqual(getAgentCheck(db, "job-2"), { state: "pending", version: null, reason: null, checkedAt: null });
  assert.equal(getWorkspacePath(db, "job-2"), null);
  assert.throws(() => recordWorkspacePath(db, "job-1", "/etc/passwd"), /Invalid workspace path/);
  assert.throws(() => recordWorkspacePath(db, "job-1", "/home/agentcloud/../root"), /Invalid workspace path/);
  assert.throws(() => recordAgentCheck(db, "job-1", { agent: "claude", ok: true }), /Unsupported agent/);
  db.close();
});

test("cleanup script covers the contract steps and a failed step never stops the rest", async () => {
  assert.match(CLEANUP_SCRIPT, /codex logout \|\| true/);
  assert.match(CLEANUP_SCRIPT, /rm -f "\$HOME\/\.codex\/auth\.json"/);
  assert.match(CLEANUP_SCRIPT, /rm -rf \/tmp\/agentcloud-\* "\$HOME\/\.cache\/agentcloud"/);
  assert.match(CLEANUP_SCRIPT, /exit 0\n$/);
  assert.deepEqual(parseCleanupOutput(cleanupOutput(["remove-scratch"])).map(({ step, ok }) => [step, ok]),
    [["codex-logout", true], ["remove-codex-auth", true], ["remove-scratch", false], ["verify-auth-absent", true]]);
  const db = new Database(":memory:");
  migrateAgentCheck(db);
  const unreachable = await runAgentCleanup(db, "job-1", async () => { throw new Error("ssh: connect refused"); });
  assert.deepEqual(unreachable, { reached: false, steps: [] });
  assert.deepEqual(listCleanupSteps(db, "job-1").map(({ step, ok }) => [step, ok]), [["cleanup-exec", false]]);
  db.close();
});

test("docker worker records a pinned Codex check and workspace path at ready", async () => {
  const { db, job } = dockerSetup();
  const result = await workOneDockerSandboxJob(db, fakeProvider(), { workerId: "w",
    verify: verifyWith({ agentCheck: evaluateAgentCheckOutput(agentOutput()) }) });
  assert.equal(result.state, "ready");
  assert.deepEqual(getAgentCheck(db, job.id), { state: "ready", version: "0.157.1", reason: null,
    checkedAt: getAgentCheck(db, job.id).checkedAt });
  assert.equal(getWorkspacePath(db, job.id), "/home/agentcloud/workspace");
  db.close();
});

test("a wrong or missing Codex keeps the environment ready but records a failed agent check", async () => {
  const wrong = dockerSetup();
  assert.equal((await workOneDockerSandboxJob(wrong.db, fakeProvider(), { workerId: "w",
    verify: verifyWith({ agentCheck: evaluateAgentCheckOutput(agentOutput("0.150.0")) }) })).state, "ready");
  const check = getAgentCheck(wrong.db, wrong.job.id);
  assert.equal(check.state, "failed");
  assert.equal(check.version, "0.150.0");
  assert.match(check.reason, /0\.157\.1 is required/);
  assert.equal(sandboxWorkspacePath({ repo_sha: "a".repeat(40) }), "/home/agentcloud/workspace/repo");
  assert.equal(sandboxWorkspacePath({ repo_sha: null }), "/home/agentcloud/workspace");
  assert.equal(wrong.db.prepare("SELECT state FROM run_box_job WHERE id = ?").get(wrong.job.id).state, "ready");
  wrong.db.close();

  const missing = dockerSetup();
  await workOneDockerSandboxJob(missing.db, fakeProvider(), { workerId: "w", verify: verifyWith() });
  assert.deepEqual(getAgentCheck(missing.db, missing.job.id).reason, "Codex version check did not run");
  missing.db.close();
});

test("the SSH verification runs codex --version before removing the one-time key and returns the check", async () => {
  const job = { id: "22222222-2222-2222-2222-222222222222", repo_url: null, repo_revision: null };
  const connection = { host: "127.0.0.1", port: 40000, verificationPublicKey: ed25519PublicKey() };
  const evidence = 'AGENTCLOUD_EVIDENCE={"account":"agentcloud","uid":1000,"workspace":"/home/agentcloud/workspace","repo_sha":"","remaining_keys":1}';
  const scripts = [];
  const replies = [{ code: 0, stdout: `${agentOutput()}${evidence}\n`, stderr: "" },
    { code: 255, stdout: "", stderr: "agentcloud@127.0.0.1: Permission denied (publickey)." }];
  const proof = await verifyDockerSandboxSsh(job, connection, { run: async (_c, script) => { scripts.push(script); return replies.shift(); } });
  assert.ok(scripts[0].indexOf("codex --version") < scripts[0].indexOf("authorized_keys"));
  assert.deepEqual(proof.agentCheck, { ok: true, version: "0.157.1", reason: null, tmux: true });
});

test("stop runs Codex cleanup inside the container before removing it and logs each step", async () => {
  const { db, job } = dockerSetup();
  const provider = fakeProvider();
  await workOneDockerSandboxJob(db, provider, { workerId: "w", verify: verifyWith() });
  const containerId = provider.containers.get(job.id).id;
  requestRunBoxStop(db, job.id, "owner-1");
  assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "w" })).state, "stopped");
  assert.deepEqual(provider.calls.map((call) => call.slice(0, 2)), [["remove", job.id], ["runAsAgent", containerId], ["remove", job.id]]);
  assert.equal(provider.calls[1][2], CLEANUP_SCRIPT);
  assert.deepEqual(listCleanupSteps(db, job.id).map(({ step, ok }) => [step, ok]), [["cleanup-exec", true],
    ["codex-logout", true], ["remove-codex-auth", true], ["remove-scratch", true], ["verify-auth-absent", true]]);
  const dump = JSON.stringify(db.prepare("SELECT * FROM run_box_cleanup_log").all());
  assert.doesNotMatch(dump, /AGENTCLOUD_CLEANUP/, "only step names and outcomes are stored");
  db.close();
});

test("a failed cleanup never blocks container removal on stop or reconciliation", async () => {
  const { db, job } = dockerSetup();
  const provider = fakeProvider({ cleanup: async () => { throw new Error("docker exec failed: container not running"); } });
  await workOneDockerSandboxJob(db, provider, { workerId: "w", verify: verifyWith() });
  requestRunBoxStop(db, job.id, "owner-1");
  assert.equal((await workOneDockerSandboxJob(db, provider, { workerId: "w" })).state, "stopped");
  assert.equal(provider.containers.size, 0);
  assert.deepEqual(listCleanupSteps(db, job.id).map(({ step, ok }) => [step, ok]), [["cleanup-exec", false]]);

  // Reconciliation of a leftover running container of a stopped job: cleanup first, then removal.
  provider.calls.length = 0;
  provider.containers.set(job.id, { id: "0123456789ab", jobId: job.id, state: "running" });
  const outcomes = await reconcileDockerSandboxes(db, provider);
  assert.deepEqual(outcomes, [{ jobId: job.id, containerId: "0123456789ab", status: "removed", orphan: false }]);
  assert.deepEqual(provider.calls.map((call) => call.slice(0, 2)), [["runAsAgent", "0123456789ab"], ["removeContainer", "0123456789ab"]]);
  db.close();
});

// Runpod: agent check over operator-key SSH, and cleanup before termination.
function runpodSetup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  authTables(db);
  migrateRunBoxJobs(db);
  migrateRunpodEvidence(db);
  migrateRunpodCleanup(db);
  const { job } = saveRunBoxDecision(db, { idempotencyKey: "idem-1", resourceRequestId: "request-1", projectId: "project-1",
    employeeId: "owner-1", organizationId: "org-1", projectRole: "owner", provider: "runpod", profileId: "runpod-rtx-4090",
    maxDurationMinutes: 60, repoUrl: "https://example.com/repo.git" });
  return { db, job };
}
function podName(job) {
  return runpodPodName(job.id, new Date(Math.floor((Date.parse(job.created_at) + job.max_duration_minutes * 60_000) / 1_000) * 1_000));
}
function runpodProvider(job) {
  const pod = { id: "pod123", name: podName(job), status: "RUNNING", gpuId: "NVIDIA GeForce RTX 4090", gpuCount: 1,
    image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404", cloud: "SECURE", diskGb: 50,
    ssh: { direct: { host: "203.0.113.10", port: 30222, username: "root" } } };
  return { async listGpuTypes() { return [{ id: "NVIDIA GeForce RTX 4090", availability: "HIGH", secureHourlyUsd: .49 }]; },
    async listPods() { return []; }, async findPodByJobId() { return null; },
    async createPod(_input, { onBeforePost }) { await onBeforePost(); return pod; }, async getPod() { return pod; } };
}
function runpodProof(jobId) {
  return { uid: 1000, account: "agentcloud", workspace: `/home/agentcloud/agentcloud/${jobId}`, repo_sha: "a".repeat(40),
    gpu_device: "NVIDIA GeForce RTX 4090", nvidia_probe: "GPU 0: NVIDIA GeForce RTX 4090", workload_value: 4, correct: true,
    cpu_ms: 1.5, gpu_ms: .8, elapsed_ms: 2000, outputSha256: "b".repeat(64), evidenceRef: `ssh:${jobId}:${"b".repeat(64)}` };
}

test("Runpod start script installs tmux, Node 22, and pinned Codex in the background, then starts sshd", () => {
  assert.match(RUNPOD_START_SCRIPT, /apt-get install -y -qq --no-install-recommends tmux/);
  assert.match(RUNPOD_START_SCRIPT, /npm install --global --no-fund --no-audit "@openai\/codex@0\.157\.1"/);
  assert.match(RUNPOD_START_SCRIPT, /\[ "\$\(codex --version 2>\/dev\/null\)" = "codex-cli 0\.157\.1" \] \|\|/);
  assert.match(RUNPOD_START_SCRIPT, /sha256sum -c -/);
  assert.match(RUNPOD_START_SCRIPT, /\) >\/var\/log\/agentcloud-toolchain\.log 2>&1 &\nexec \/start\.sh$/);
  // The toolchain step starts only after the host key variables are unset.
  assert.ok(RUNPOD_START_SCRIPT.indexOf("unset AGENTCLOUD_SSH_HOST_KEY_B64") < RUNPOD_START_SCRIPT.indexOf("npm install"));
  execFileSync("bash", ["-n"], { input: RUNPOD_START_SCRIPT });
});

test("Runpod worker records the Codex check after the SSH proof; failure keeps the job ready", async () => {
  for (const [check, expected] of [[async () => agentOutput(), "ready"], [async () => { throw new Error("timeout"); }, "failed"]]) {
    const { db, job } = runpodSetup();
    const seen = [];
    const result = await workOneRunpodJob(db, runpodProvider(job), { workerId: "w",
      connection: { keyFile: "/private/key", publicKey: ed25519PublicKey() }, checkSshConfig() {},
      checkCleanupGuard: async () => true, verify: async () => runpodProof(job.id),
      checkAgent: async (_job, connection) => { seen.push(connection); return check(); } });
    assert.equal(result.state, "ready");
    assert.equal(getAgentCheck(db, job.id).state, expected);
    assert.equal(getWorkspacePath(db, job.id), `/home/agentcloud/agentcloud/${job.id}/repo`);
    assert.match(seen[0].knownHostsFile, /known_hosts$/, "the check uses the pinned host key file");
    if (expected === "failed") assert.equal(getAgentCheck(db, job.id).reason, "Codex version check over SSH failed");
    db.close();
  }
});

test("checkRunpodAgent waits for the toolchain marker and runs as agentcloud", async () => {
  const calls = [];
  const output = await checkRunpodAgent({}, { host: "203.0.113.10" }, {
    run: async (_connection, account, script, options) => { calls.push({ account, script, options }); return agentOutput(); } });
  assert.equal(evaluateAgentCheckOutput(output).ok, true);
  assert.equal(calls[0].account, "agentcloud");
  assert.match(calls[0].script, /\/var\/lib\/agentcloud\/toolchain\.done/);
  assert.match(calls[0].script, /codex --version/);
});

test("Runpod reconcile cleans up over SSH before terminatePod and tolerates cleanup failure", async () => {
  for (const failing of [false, true]) {
    const { db, job } = runpodSetup();
    claimRunBoxJob(db, "worker");
    recordRunBoxAllocation(db, job.id, "worker", "runpod", "pod123");
    migrateRunBoxSsh(db);
    recordRunBoxSshEndpoint(db, job.id, { host: "203.0.113.10", port: 30222, username: "agentcloud",
      hostPublicKey: ed25519PublicKey(), authorizedFingerprints: [] });
    requestRunBoxStop(db, job.id, "owner-1");
    const order = [];
    const run = async (connection, account, script) => {
      order.push(["ssh", account, readFileSync(connection.knownHostsFile, "utf8").startsWith("[203.0.113.10]:30222 ")]);
      if (failing) throw new Error("Runpod SSH command failed (exit 255)");
      assert.equal(script, CLEANUP_SCRIPT);
      return cleanupOutput();
    };
    const provider = { async listPods() { return [{ id: "pod123", name: podName(job) }]; },
      async terminatePod(id) { order.push(["terminate", id]); }, async getPod() { return null; } };
    const outcomes = await reconcileRunpodJobs(db, provider, { workerId: "worker", requestStop: requestRunBoxStop,
      checkCleanupGuard: async () => true,
      cleanupAgent: createRunpodAgentCleanup(db, { keyFile: "/private/key", publicKey: ed25519PublicKey() }, { run }) });
    assert.equal(outcomes[0].status, "stopped");
    assert.deepEqual(order, [["ssh", "agentcloud", true], ["terminate", "pod123"]]);
    const steps = listCleanupSteps(db, job.id).map(({ step, ok }) => [step, ok]);
    assert.deepEqual(steps[0], ["cleanup-exec", !failing]);
    assert.equal(steps.length, failing ? 1 : 5);
    db.close();
  }
});
