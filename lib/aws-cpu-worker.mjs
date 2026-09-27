import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AWS_CPU_PROFILE_ID, claimRunBoxJob, recordRunBoxAllocation, recordRunBoxRevision, releaseRunBoxLease,
  renewRunBoxLease, requestRunBoxStop, transitionRunBoxJob } from "./run-box-jobs.mjs";
import { authorizedKeysForProject, migrateSshKeys, normalizePublicKey, sshFingerprint } from "./ssh-keys.mjs";
import { getRunBoxSshEndpoint, knownHostsLine, migrateRunBoxSsh, recordRunBoxSshEndpoint } from "./run-box-ssh.mjs";
import { CPU_SSH_USER, runCpuSsh, validateSshSourceCidr } from "./aws-cpu-provider.mjs";
import { CODEX_VERSION, migrateAgentCheck, recordAgentCheck, recordWorkspacePath, runAgentCleanup } from "./agent-check.mjs";
import { validRunnerKey } from "./codex-runner-key.mjs";
import { applyAwsCpuSshAccess, migrateAwsCpuSshAccess } from "./aws-cpu-ssh-access.mjs";

// Worker for the aws-cpu profile (HAC-125). A job reaches `ready` only after:
// the instance runs with a public IPv4 address; a tcp/22 rule admits only the
// requester's /32; SSM read back the on-box ed25519 host key and sshd serves it; and
// an SSH session as `agentcloud`, pinned to that key, saw the bootstrap marker, Codex
// 0.157.1, tmux, git, Node 22, and the approved repository checkout. The endpoint is
// then recorded in run_box_ssh_endpoint so the desktop terminal connects unchanged.

export const NO_DEVICE_KEYS = "No registered device SSH keys for this project; sign in to the desktop app first";
const LEASE_MS = 10 * 60_000;
const BOOTSTRAP_TIMEOUT_MS = 20 * 60_000;

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function current(db, id) { return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id); }

export function migrateAwsCpuEnvironment(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aws_cpu_environment (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
    ssh_source_cidr TEXT NOT NULL,
    authorized_keys TEXT NOT NULL,
    instance_id TEXT,
    public_ip TEXT,
    ssh_rule_id TEXT,
    host_public_key TEXT,
    host_key_command_id TEXT,
    bootstrap_step TEXT,
    last_wait TEXT,
    codex_version TEXT,
    tmux_version TEXT,
    git_version TEXT,
    node_version TEXT,
    workspace TEXT,
    external_host_key_match INTEGER,
    output_sha256 TEXT,
    verified_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}

// `authorized_keys` holds member device keys. HAC-153: the backend's Codex runner
// key is stored in the same JSON list tagged `server: true` and returned as `server_key`.
export function getAwsCpuEnvironment(db, jobId) {
  const row = db.prepare("SELECT * FROM aws_cpu_environment WHERE job_id = ?").get(jobId);
  if (!row) return null;
  const keys = JSON.parse(row.authorized_keys);
  const server = keys.find((key) => key.server === true) || null;
  return { ...row, authorized_keys: keys.filter((key) => key.server !== true),
    server_key: server ? { publicKey: server.publicKey, fingerprint: server.fingerprint } : null };
}

function update(db, jobId, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE aws_cpu_environment SET ${keys.map((key) => `${key} = @${key}`).join(", ")}, updated_at = @updated_at
    WHERE job_id = @job_id`).run({ ...fields, updated_at: new Date().toISOString(), job_id: jobId });
}

function approvalStillValid(db, job) {
  let repo;
  try { repo = new URL(job.repo_url); } catch { return false; }
  if (repo.protocol !== "https:" || !repo.hostname || repo.username || repo.password || repo.search || repo.hash) return false;
  if (!Number.isFinite(Date.parse(job.created_at)) || ![60, 120].includes(job.max_duration_minutes) ||
      Date.now() >= Date.parse(job.created_at) + job.max_duration_minutes * 60_000) return false;
  const decision = db.prepare("SELECT * FROM run_box_decision WHERE id = ?").get(job.decision_id);
  if (!decision || decision.outcome !== "approved" || decision.provider !== "aws-ec2" ||
      decision.profile_id !== AWS_CPU_PROFILE_ID || job.profile_id !== AWS_CPU_PROFILE_ID ||
      decision.project_id !== job.project_id || decision.max_duration_minutes !== job.max_duration_minutes) return false;
  return Boolean(db.prepare(`SELECT 1 FROM project_organization po
    JOIN member m ON m.organizationId = po.organization_id AND m.userId = ?
    LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
    JOIN user u ON u.id = m.userId
    WHERE po.project_id = ? AND po.organization_id = ? AND u.emailVerified = 1
      AND (m.role IN ('owner', 'admin') OR pm.role = 'owner')`).get(decision.employee_id, job.project_id, decision.organization_id));
}

// The operator key lets the worker run the agent check as `agentcloud`; it is installed
// alongside member device keys and is not reported as a member fingerprint.
export function validateAwsCpuConnection(connection) {
  requireValue(connection && typeof connection.keyFile === "string" && connection.keyFile.startsWith("/"),
    "AWS CPU operator SSH private key file must be configured");
  let publicKey;
  try { publicKey = normalizePublicKey(connection.publicKey); } catch { throw new Error("AWS CPU operator ed25519 public key must be configured"); }
  try { requireValue(statSync(connection.keyFile).isFile(), ""); } catch { throw new Error("AWS CPU operator SSH key file is unavailable"); }
  return publicKey;
}

async function withKnownHosts(line, action) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-known-hosts-"));
  try {
    await chmod(directory, 0o700);
    const file = path.join(directory, "known_hosts");
    await writeFile(file, `${line}\n`, { mode: 0o600 });
    return await action(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function deferStop(db, job, workerId, reason) {
  const attempted = db.prepare("SELECT 1 FROM run_box_transition WHERE job_id = ? AND to_state = 'allocating' LIMIT 1").get(job.id);
  if (job.state !== "stopping") transitionRunBoxJob(db, job.id, "stopping", workerId, { reason });
  if (attempted || job.provider_resource_id) { releaseRunBoxLease(db, job.id, workerId); return { jobId: job.id, state: "stopping" }; }
  const evidenceRef = `job:never-allocated:${job.id}`;
  transitionRunBoxJob(db, job.id, "stopped", workerId, { evidenceRef });
  return { jobId: job.id, state: "stopped", evidenceRef };
}

function wait(db, jobId, workerId, state, reason, extra = {}) {
  update(db, jobId, { last_wait: reason.slice(0, 256), ...extra });
  releaseRunBoxLease(db, jobId, workerId);
  return { jobId, state, retry: true, reason };
}

// `sshSourceCidr` is the requester's public /32 (validated before any claim).
// `capMinutes` shortens the instance deadline (used by the supervised smoke test).
// `probeHostKey(host)` optionally confirms from the worker host that the public
// endpoint serves the pinned key; the agent check over SSH proves it as well.
export async function workOneAwsCpuJob(db, provider, { workerId = `aws-cpu-worker-${process.pid}`, connection,
  sshSourceCidr, capMinutes, probeHostKey = null, now = () => new Date(), checkConnection = validateAwsCpuConnection,
  runnerKey = null } = {}) {
  const cidr = validateSshSourceCidr(sshSourceCidr);
  const operatorKey = checkConnection(connection);
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  migrateAwsCpuEnvironment(db);
  migrateAgentCheck(db);
  migrateAwsCpuSshAccess(db);
  const job = claimRunBoxJob(db, workerId, now(), LEASE_MS, "aws-ec2", { profileId: AWS_CPU_PROFILE_ID });
  if (!job) return null;
  const heartbeat = setInterval(() => {
    try { renewRunBoxLease(db, job.id, workerId, LEASE_MS); }
    catch { clearInterval(heartbeat); }
  }, 30_000);
  heartbeat.unref();
  try {
    await provider.identifyWorker();
    let fresh = current(db, job.id);
    if (fresh.stop_requested_at || fresh.state === "stopping") return deferStop(db, fresh, workerId, "Stop requested");

    if (fresh.state === "allocating") {
      requireValue(approvalStillValid(db, fresh), "Approval, owner membership, profile, or deadline invalid before launch");
      let environment = getAwsCpuEnvironment(db, job.id);
      if (!environment) {
        const members = authorizedKeysForProject(db, fresh.project_id).map(({ publicKey, fingerprint }) => ({ publicKey, fingerprint }));
        requireValue(members.length > 0, NO_DEVICE_KEYS);
        const runner = validRunnerKey(runnerKey);
        const recorded = runner ? [...members, { ...runner, server: true }] : members;
        const at = new Date().toISOString();
        db.prepare(`INSERT INTO aws_cpu_environment (job_id, ssh_source_cidr, authorized_keys, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)`).run(job.id, cidr, JSON.stringify(recorded), at, at);
        environment = getAwsCpuEnvironment(db, job.id);
      }
      const keys = [...new Set([operatorKey, ...environment.authorized_keys.map((key) => key.publicKey),
        ...(environment.server_key ? [environment.server_key.publicKey] : [])])];
      const instance = await provider.allocate(fresh, { authorizedKeys: keys, capMinutes });
      update(db, job.id, { instance_id: instance.InstanceId });
      fresh = recordRunBoxAllocation(db, job.id, workerId, "aws-ec2", instance.InstanceId);
    }
    fresh = current(db, job.id);
    if (fresh.stop_requested_at) return deferStop(db, fresh, workerId, "Stop requested after allocation");
    requireValue(["connecting", "verifying"].includes(fresh.state), `Worker cannot process state ${fresh.state}`);
    const environment = getAwsCpuEnvironment(db, job.id);
    requireValue(environment, "CPU environment record missing for allocated job");

    const instance = await provider.inspect(fresh);
    if (!instance || ["shutting-down", "terminated", "stopping", "stopped"].includes(instance.State?.Name))
      throw new Error("Allocated EC2 instance is missing or shutting down");
    const launchedAt = Date.parse(instance.LaunchTime || "");
    if (instance.State?.Name !== "running" || !instance.PublicIpAddress)
      return wait(db, job.id, workerId, fresh.state, "Waiting for the instance to run with a public IPv4 address");
    const host = instance.PublicIpAddress;
    const rule = await provider.authorizeSsh(fresh, environment.ssh_source_cidr);
    update(db, job.id, { public_ip: host, ssh_rule_id: rule.ruleId });
    // HAC-166: the requester's own address(es), recorded by the app, get their own
    // job-tagged rules; an address equal to the worker's reuses the worker's rule.
    await applyAwsCpuSshAccess(db, provider, fresh, { keepCidr: environment.ssh_source_cidr });
    if (fresh.state === "connecting")
      fresh = transitionRunBoxJob(db, job.id, "verifying", workerId, { evidenceRef: `ec2:${instance.InstanceId}` });

    const readback = await provider.readHostKey(instance.InstanceId);
    if (readback.state === "failed") throw new Error(`CPU bootstrap failed at step ${readback.step}`);
    if (readback.state !== "ready") {
      if (Number.isFinite(launchedAt) && now().getTime() - launchedAt > BOOTSTRAP_TIMEOUT_MS)
        throw new Error(`CPU bootstrap did not finish within 20 minutes (step ${readback.step})`);
      return wait(db, job.id, workerId, fresh.state, `Bootstrapping: ${readback.step}`, { bootstrap_step: readback.step });
    }
    // The host key is pinned once. A different key later means the box was replaced or tampered with.
    requireValue(!environment.host_public_key || environment.host_public_key === readback.hostPublicKey,
      "Host key changed after it was pinned");
    const authorizedFingerprints = environment.authorized_keys.map((key) => key.fingerprint);
    requireValue(environment.authorized_keys.every((key) => sshFingerprint(key.publicKey) === key.fingerprint),
      "Recorded authorized keys are inconsistent");
    requireValue(!environment.server_key || sshFingerprint(environment.server_key.publicKey) === environment.server_key.fingerprint,
      "Recorded server key is inconsistent");
    const endpoint = { host, port: 22, username: CPU_SSH_USER, hostPublicKey: readback.hostPublicKey, authorizedFingerprints,
      serverFingerprint: environment.server_key?.fingerprint ?? null };
    recordRunBoxSshEndpoint(db, job.id, endpoint);
    update(db, job.id, { host_public_key: readback.hostPublicKey, host_key_command_id: readback.commandId || null, bootstrap_step: "done" });

    let external = null;
    if (probeHostKey) {
      let served;
      try { served = await probeHostKey(host); }
      catch { return wait(db, job.id, workerId, "verifying", "Public SSH endpoint is not reachable yet from this worker's address"); }
      external = served === readback.hostPublicKey;
      requireValue(external, "Public SSH endpoint serves a different host key than the pinned key");
    }
    let proof;
    try {
      proof = await withKnownHosts(knownHostsLine(endpoint), (knownHostsFile) =>
        provider.checkAgent(fresh, { host, port: 22, keyFile: connection.keyFile, knownHostsFile }));
    } catch (error) {
      if (error.hostKeyMismatch || !error.retryable) throw error;
      return wait(db, job.id, workerId, "verifying", "SSH to the environment is not reachable yet from this worker's address");
    }
    recordRunBoxRevision(db, job.id, workerId, proof.repo_sha);
    update(db, job.id, { codex_version: proof.codex, tmux_version: proof.tmux, git_version: proof.git, node_version: proof.node,
      workspace: proof.workspace, external_host_key_match: external === null ? null : external ? 1 : 0,
      output_sha256: proof.outputSha256, verified_at: new Date().toISOString(), last_wait: null });
    // Stage 2 listing fields (HAC-121) for aws-cpu: the proof above already saw Codex
    // CODEX_VERSION on PATH as agentcloud, and bootstrap wrote the file credential store.
    recordAgentCheck(db, job.id, { agent: "codex", ok: true, version: CODEX_VERSION });
    recordWorkspacePath(db, job.id, proof.workspace);
    fresh = current(db, job.id);
    if (fresh.stop_requested_at) return deferStop(db, fresh, workerId, "Stop requested during verification");
    const evidenceRef = `ssh:${instance.InstanceId}:${proof.outputSha256}`;
    transitionRunBoxJob(db, job.id, "ready", workerId, { evidenceRef });
    releaseRunBoxLease(db, job.id, workerId);
    return { jobId: job.id, state: "ready", evidenceRef, host, instanceId: instance.InstanceId };
  } catch (error) {
    const fresh = current(db, job.id);
    if (fresh && !["stopped", "failed"].includes(fresh.state)) {
      try {
        transitionRunBoxJob(db, job.id, "failed", workerId, { reason: String(error.message).slice(0, 256) });
        releaseRunBoxLease(db, job.id, workerId);
      } catch { /* A lost lease is handled by the next claimant. */ }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

// SSH key revocation for aws-cpu (HAC-132 parity with docker-local and Runpod, added in
// HAC-153). Reconciles each ready environment's `agentcloud` authorized keys against
// current project membership. The operator key stays (the worker reaches the box with
// it) and the Codex runner key stays only while it is still this install's key. A box
// whose keys cannot be replaced and verified is stopped rather than left with stale access.
export async function reconcileAwsCpuSshAccess(db, connection, { run = runCpuSsh, requestStop = requestRunBoxStop,
  runnerKey = null, checkConnection = validateAwsCpuConnection } = {}) {
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  const outcomes = [];
  const jobs = db.prepare(`SELECT * FROM run_box_job WHERE provider = 'aws-ec2' AND profile_id = ?
    AND state = 'ready' AND stop_requested_at IS NULL`).all(AWS_CPU_PROFILE_ID);
  for (const job of jobs) {
    const endpoint = getRunBoxSshEndpoint(db, job.id);
    const keys = authorizedKeysForProject(db, job.project_id);
    const fingerprints = [...new Set(keys.map((key) => key.fingerprint))];
    if (endpoint && JSON.stringify(endpoint.authorizedFingerprints) === JSON.stringify(fingerprints)) continue;
    try {
      requireValue(endpoint, "AWS CPU SSH access cannot be reconciled without a pinned endpoint");
      const operatorKey = checkConnection(connection);
      const candidate = validRunnerKey(runnerKey);
      const runner = candidate && endpoint.serverFingerprint === candidate.fingerprint ? candidate : null;
      const wanted = [...new Set([operatorKey, ...keys.map((key) => key.publicKey), ...(runner ? [runner.publicKey] : [])])];
      const encoded = Buffer.from(wanted.map((key) => `${key}\n`).join("")).toString("base64");
      const script = `set -euo pipefail\numask 077\ntmp=$(mktemp "$HOME/.ssh/.authorized_keys.XXXXXX")\n` +
        `trap 'rm -f "$tmp"' EXIT\nprintf '%s' '${encoded}' | base64 -d > "$tmp"\nchmod 600 "$tmp"\n` +
        `mv -f "$tmp" "$HOME/.ssh/authorized_keys"\nbase64 -w0 "$HOME/.ssh/authorized_keys"\n`;
      const result = await withKnownHosts(knownHostsLine(endpoint), (knownHostsFile) =>
        run({ host: endpoint.host, port: endpoint.port, keyFile: connection.keyFile, knownHostsFile }, script, { timeoutMs: 60_000 }));
      requireValue(result.code === 0 && String(result.stdout).trim() === encoded, "AWS CPU authorized key replacement could not be verified");
      recordRunBoxSshEndpoint(db, job.id, { ...endpoint, authorizedFingerprints: fingerprints, serverFingerprint: runner?.fingerprint ?? null });
      outcomes.push({ jobId: job.id, status: "access-updated" });
    } catch (error) {
      requestStop(db, job.id, "aws-cpu-access-reconciler");
      outcomes.push({ jobId: job.id, status: "access-update-failed", error: String(error?.message || error).slice(0, 256) });
    }
  }
  return outcomes;
}

// Teardown cleanup for aws-cpu (Stage 2 parity): best effort over SSH as agentcloud with
// the operator key and the pinned host key, before the reconciler terminates the instance.
// Removes ~/.codex/auth.json and AgentCloud scratch; never throws.
export function createAwsCpuAgentCleanup(db, connection, { run = runCpuSsh } = {}) {
  return async (job) => {
    migrateAgentCheck(db);
    if (job?.profile_id !== AWS_CPU_PROFILE_ID) return null;
    const endpoint = getRunBoxSshEndpoint(db, job.id);
    if (!endpoint || typeof connection?.keyFile !== "string")
      return runAgentCleanup(db, job.id, async () => { throw new Error("No SSH endpoint or operator key for cleanup"); });
    try {
      return await withKnownHosts(knownHostsLine(endpoint), (knownHostsFile) => runAgentCleanup(db, job.id, async (script) => {
        const result = await run({ host: endpoint.host, port: endpoint.port, keyFile: connection.keyFile, knownHostsFile }, script, { timeoutMs: 30_000 });
        if (result.code !== 0) throw new Error("Cleanup SSH failed");
        return { code: 0, stdout: result.stdout };
      }));
    } catch { return null; }
  };
}
