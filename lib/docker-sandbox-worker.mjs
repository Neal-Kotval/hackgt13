import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { claimRunBoxJob, LOCAL_DOCKER_PROFILE_ID, recordRunBoxAllocation, recordRunBoxRevision,
  releaseRunBoxLease, renewRunBoxLease, requestRunBoxStop, transitionRunBoxJob } from "./run-box-jobs.mjs";
import { authorizedKeysForProject, normalizePublicKey } from "./ssh-keys.mjs";
import { getRunBoxSshEndpoint, knownHostsLine, recordRunBoxSshEndpoint } from "./run-box-ssh.mjs";
import { sandboxContainerName } from "./docker-sandbox-provider.mjs";
import { getContainerTemplate, templateIdFromProfile } from "./container-templates.mjs";

// docker-local worker (HAC-88). A job reaches ready only after SSH to the
// container succeeds against the pinned per-job host key, as the non-root
// agentcloud account, with the worker's one-time verification key removed
// again so only member device keys remain. Private keys are never logged or
// stored in the database; they live in a 0700 temporary directory for one cycle.

export const SANDBOX_USER = "agentcloud";
export const NO_DEVICE_KEYS = "No registered device SSH keys for this project; sign in to the desktop app first";
const LEASE_MS = 2 * 60_000;
const MAX_OUTPUT = 64 * 1024;

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function current(db, id) { return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id); }

export function sandboxDeadline(job) {
  return Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
}

function approvalStillValid(db, job) {
  const decision = db.prepare("SELECT * FROM run_box_decision WHERE id = ?").get(job.decision_id);
  if (!decision || decision.outcome !== "approved" || decision.provider !== "docker-local" ||
      decision.profile_id !== job.profile_id ||
      (job.profile_id !== LOCAL_DOCKER_PROFILE_ID && !templateIdFromProfile(job.profile_id)) ||
      decision.project_id !== job.project_id || decision.max_duration_minutes !== job.max_duration_minutes ||
      ![60, 120].includes(job.max_duration_minutes) || !Number.isFinite(Date.parse(job.created_at))) return false;
  if (job.repo_url) {
    let repo;
    try { repo = new URL(job.repo_url); } catch { return false; }
    if (repo.protocol !== "https:" || !repo.hostname || repo.username || repo.password || repo.search || repo.hash) return false;
  }
  return Boolean(db.prepare(`SELECT 1 FROM project_organization po
    JOIN member m ON m.organizationId = po.organization_id AND m.userId = ?
    LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
    JOIN user u ON u.id = m.userId
    WHERE po.project_id = ? AND po.organization_id = ? AND u.emailVerified = 1
      AND (m.role IN ('owner', 'admin') OR pm.role = 'owner')`).get(decision.employee_id, job.project_id, decision.organization_id));
}

// Generates an unencrypted ed25519 keypair inside `directory` (caller owns cleanup).
export function generateSandboxKeypair(directory, name) {
  const keyFile = path.join(directory, name);
  return new Promise((resolve, reject) => {
    execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", keyFile], { timeout: 30_000 }, (error) => {
      if (error) return reject(new Error("ssh-keygen failed to create a sandbox key"));
      try {
        resolve({ keyFile, privateKey: readFileSync(keyFile, "utf8"),
          publicKey: normalizePublicKey(readFileSync(`${keyFile}.pub`, "utf8")) });
      } catch (failure) { reject(failure); }
    });
  });
}

export function runSandboxSsh(connection, script, { timeoutMs = 60_000 } = {}) {
  requireValue(connection?.host === "127.0.0.1" && Number.isInteger(connection.port) &&
    connection.port > 0 && connection.port <= 65535, "Sandbox SSH endpoint must be a loopback port");
  requireValue(path.isAbsolute(connection.keyFile || "") && path.isAbsolute(connection.knownHostsFile || ""),
    "Sandbox SSH key and pinned known-hosts file are required");
  const args = ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${connection.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR",
    "-i", connection.keyFile, "-p", String(connection.port), `${connection.username || SANDBOX_USER}@${connection.host}`, "bash -s"];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failed = null;
    const timer = setTimeout(() => { failed = "Sandbox SSH command timed out"; child.kill("SIGKILL"); }, timeoutMs);
    const collect = (append) => (data) => {
      append(String(data));
      if (stdout.length + stderr.length > MAX_OUTPUT) { failed = "Sandbox SSH output exceeded limit"; child.kill("SIGKILL"); }
    };
    child.stdin.on("error", () => { /* ssh may exit before reading the script. */ });
    child.stdout.on("data", collect((text) => { stdout += text; }));
    child.stderr.on("data", collect((text) => { stderr += text; }));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return reject(new Error(failed));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

function shellValue(value) {
  // Base64 keeps arbitrary values out of shell parsing; decoded inside the sandbox.
  return `$(printf '%s' '${Buffer.from(value || "").toString("base64")}' | base64 -d)`;
}

function verificationScript(job, verificationPublicKey) {
  // Runs as the sandbox user over SSH, using only tools present in the image.
  return `set -euo pipefail
[ "$(id -un)" = "${SANDBOX_USER}" ]
[ "$(id -u)" -ne 0 ]
workspace="$HOME/workspace"
[ -d "$workspace" ]
[ -w "$workspace" ]
repo_sha=""
repo_url="${shellValue(job.repo_url)}"
if [ -n "$repo_url" ]; then
  [ -d "$workspace/repo/.git" ] || git clone --quiet -- "$repo_url" "$workspace/repo"
  repo_sha=$(git -C "$workspace/repo" rev-parse HEAD)
  revision="${shellValue(job.repo_revision)}"
  [ -z "$revision" ] || [ "$revision" = "$repo_sha" ]
fi
blob="${shellValue(verificationPublicKey.split(" ")[1])}"
keys="$HOME/.ssh/authorized_keys"
grep -v -F -- "$blob" "$keys" > "$keys.next" || true
chmod 600 "$keys.next"
mv "$keys.next" "$keys"
if grep -q -F -- "$blob" "$keys"; then exit 3; fi
remaining=$(grep -c '^ssh-' "$keys" || true)
printf 'AGENTCLOUD_EVIDENCE={"account":"%s","uid":%s,"workspace":"%s","repo_sha":"%s","remaining_keys":%s}\\n' \\
  "$(id -un)" "$(id -u)" "$workspace" "$repo_sha" "$remaining"
`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Verifies the sandbox with the worker's one-time key, then proves that key is
// no longer accepted. Retries only while sshd is starting.
export async function verifyDockerSandboxSsh(job, connection, { run = runSandboxSsh, attempts = 40, delayMs = 500 } = {}) {
  requireValue(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(connection?.verificationPublicKey || ""),
    "Sandbox verification key is required");
  let result;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await run(connection, verificationScript(job, connection.verificationPublicKey));
    if (result.code === 0) break;
    // 255 is ssh's own failure (sshd not yet listening); anything else is the proof failing.
    if (result.code !== 255 || /Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(result.stderr)) break;
    await sleep(delayMs);
  }
  if (result.code !== 0) {
    throw new Error(/Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(result.stderr)
      ? "Sandbox host key did not match the pinned key" : `Sandbox SSH verification failed (exit ${result.code})`);
  }
  const lines = result.stdout.split("\n").filter((line) => line.startsWith("AGENTCLOUD_EVIDENCE="));
  requireValue(lines.length === 1, "Sandbox SSH proof is missing or ambiguous");
  let proof;
  try { proof = JSON.parse(lines[0].slice("AGENTCLOUD_EVIDENCE=".length)); }
  catch { throw new Error("Sandbox SSH proof is invalid"); }
  requireValue(proof.account === SANDBOX_USER && Number.isInteger(proof.uid) && proof.uid > 0 &&
    proof.workspace === `/home/${SANDBOX_USER}/workspace` && Number.isInteger(proof.remaining_keys) &&
    proof.remaining_keys >= 1 && (job.repo_url ? /^[a-f0-9]{40,64}$/.test(proof.repo_sha) : proof.repo_sha === ""),
  "Sandbox SSH proof is incomplete");
  const denied = await run(connection, "true\n");
  requireValue(denied.code === 255 && /Permission denied/i.test(denied.stderr),
    "Sandbox still accepts the worker verification key");
  const outputSha256 = createHash("sha256").update(lines[0]).digest("hex");
  return { ...proof, repo_sha: proof.repo_sha || null, verificationKeyRemoved: true, outputSha256,
    evidenceRef: `ssh:${job.id}:${outputSha256}` };
}

async function stopSandbox(db, provider, job, workerId) {
  await provider.remove(job.id);
  requireValue(!(await provider.find(job.id)), "Sandbox container still exists after removal");
  const evidenceRef = `docker:removed:${sandboxContainerName(job.id)}:absent`;
  if (current(db, job.id).state !== "stopping")
    transitionRunBoxJob(db, job.id, "stopping", workerId, { reason: "Stop requested" });
  transitionRunBoxJob(db, job.id, "stopped", workerId, { evidenceRef });
  return { jobId: job.id, state: "stopped", evidenceRef };
}

async function allocate(db, provider, job, workerId, { verify, keygen }) {
  requireValue(approvalStillValid(db, job), "Local sandbox approval, owner membership, or profile invalid");
  const templateId = templateIdFromProfile(job.profile_id);
  const template = templateId ? getContainerTemplate(db, templateId) : null;
  requireValue(!templateId || template, "Selected container template is unavailable");
  const members = authorizedKeysForProject(db, job.project_id);
  requireValue(members.length > 0, NO_DEVICE_KEYS);
  const memberKeys = [...new Set(members.map((key) => key.publicKey))];
  const fingerprints = [...new Set(members.map((key) => key.fingerprint))];
  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-sandbox-"));
  chmodSync(directory, 0o700);
  try {
    const host = await keygen(directory, "host_ed25519");
    const verifier = await keygen(directory, "verify_ed25519");
    // Keys from an interrupted attempt are gone, so a resumed job gets a fresh
    // container under the same stable name instead of a second one.
    await provider.remove(job.id);
    const container = await provider.create({ jobId: job.id,
      hostPrivateKeyB64: Buffer.from(host.privateKey).toString("base64"),
      authorizedKeys: [...memberKeys, verifier.publicKey],
      ...(template ? { imageId: template.image_id } : {}) });
    let fresh = recordRunBoxAllocation(db, job.id, workerId, "docker-local", sandboxContainerName(job.id));
    const port = await provider.sshPort(job.id);
    const endpoint = { host: "127.0.0.1", port, username: SANDBOX_USER, hostPublicKey: host.publicKey };
    recordRunBoxSshEndpoint(db, job.id, { ...endpoint, authorizedFingerprints: fingerprints });
    if (fresh.state === "connecting")
      fresh = transitionRunBoxJob(db, job.id, "verifying", workerId, { evidenceRef: `docker:${container.containerId}` });
    const knownHostsFile = path.join(directory, "known_hosts");
    writeFileSync(knownHostsFile, `${knownHostsLine(endpoint)}\n`, { mode: 0o600 });
    const proof = await verify(fresh, { ...endpoint, knownHostsFile, keyFile: verifier.keyFile,
      verificationPublicKey: verifier.publicKey });
    requireValue(proof?.verificationKeyRemoved === true && typeof proof.evidenceRef === "string",
      "Sandbox verification did not remove the worker key");
    return { proof, port };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function workOneDockerSandboxJob(db, provider, { workerId = `docker-local-worker-${process.pid}`,
  verify = verifyDockerSandboxSsh, keygen = generateSandboxKeypair, leaseMs = LEASE_MS } = {}) {
  const job = claimRunBoxJob(db, workerId, new Date(), leaseMs, "docker-local");
  if (!job) return null;
  const heartbeat = setInterval(() => {
    try { renewRunBoxLease(db, job.id, workerId, leaseMs); }
    catch { clearInterval(heartbeat); }
  }, Math.max(1_000, Math.floor(leaseMs / 4)));
  heartbeat.unref();
  try {
    let fresh = current(db, job.id);
    if (!fresh.stop_requested_at && Date.now() >= sandboxDeadline(fresh)) {
      requestRunBoxStop(db, job.id, "docker-local-expiry");
      fresh = current(db, job.id);
    }
    if (fresh.stop_requested_at || fresh.state === "stopping") {
      try { return await stopSandbox(db, provider, fresh, workerId); }
      catch (error) {
        // Keep the stop request pending (never mark it failed); the next cycle retries.
        try { releaseRunBoxLease(db, job.id, workerId); } catch { /* Lease already lost. */ }
        throw error;
      }
    }
    requireValue(["allocating", "connecting", "verifying"].includes(fresh.state), "Local sandbox job is not allocatable");
    const { proof, port } = await allocate(db, provider, fresh, workerId, { verify, keygen });
    if (proof.repo_sha) recordRunBoxRevision(db, job.id, workerId, proof.repo_sha);
    if (current(db, job.id).stop_requested_at) return await stopSandbox(db, provider, current(db, job.id), workerId);
    transitionRunBoxJob(db, job.id, "ready", workerId, { evidenceRef: proof.evidenceRef });
    releaseRunBoxLease(db, job.id, workerId);
    return { jobId: job.id, state: "ready", port, evidenceRef: proof.evidenceRef };
  } catch (error) {
    const fresh = current(db, job.id);
    if (fresh && !["stopped", "failed"].includes(fresh.state)) {
      try { transitionRunBoxJob(db, job.id, "failed", workerId, { reason: String(error.message).slice(0, 256) }); }
      catch { /* A lost lease leaves the next claimant responsible. */ }
    }
    // A failed sandbox must not keep a container; the reconciler retries if this fails.
    try { await provider.remove(job.id); } catch { /* Reconciled later. */ }
    try { releaseRunBoxLease(db, job.id, workerId); } catch { /* Lease already lost. */ }
    throw error;
  } finally { clearInterval(heartbeat); }
}

// Requests stop for expired sandboxes and ready sandboxes whose container
// vanished, and removes labelled containers whose job is stopped, failed, or unknown.
export async function reconcileDockerSandboxes(db, provider, { now = new Date(), requestStop = requestRunBoxStop } = {}) {
  const outcomes = [];
  const jobs = db.prepare("SELECT * FROM run_box_job WHERE provider = 'docker-local'").all();
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    if (["stopped", "failed"].includes(job.state) || job.stop_requested_at) continue;
    if (now.getTime() >= sandboxDeadline(job)) {
      requestStop(db, job.id, "docker-local-expiry");
      outcomes.push({ jobId: job.id, status: "expired" });
    }
  }
  const containers = await provider.listManaged();
  for (const container of containers) {
    const job = byId.get(container.jobId);
    if (job && !["stopped", "failed"].includes(job.state)) continue;
    try {
      await provider.removeContainer(container.id);
      outcomes.push({ jobId: container.jobId, containerId: container.id, status: "removed", orphan: !job });
    } catch (error) {
      outcomes.push({ jobId: container.jobId, containerId: container.id, status: "retry",
        error: String(error?.message || error).slice(0, 256) });
    }
  }
  for (const job of jobs) {
    if (job.state !== "ready" || job.stop_requested_at) continue;
    const container = containers.find((item) => item.jobId === job.id);
    if (!container || container.state !== "running") {
      requestStop(db, job.id, "docker-local-reconciler");
      outcomes.push({ jobId: job.id, status: "container-lost" });
      continue;
    }
    const endpoint = getRunBoxSshEndpoint(db, job.id);
    const keys = authorizedKeysForProject(db, job.project_id);
    const fingerprints = [...new Set(keys.map((key) => key.fingerprint))];
    if (endpoint && JSON.stringify(endpoint.authorizedFingerprints) === JSON.stringify(fingerprints)) continue;
    try {
      await provider.replaceAuthorizedKeys(job.id, [...new Set(keys.map((key) => key.publicKey))]);
      requireValue(endpoint, "Sandbox SSH endpoint is missing");
      recordRunBoxSshEndpoint(db, job.id, { ...endpoint, authorizedFingerprints: fingerprints });
      outcomes.push({ jobId: job.id, status: "access-updated" });
    } catch (error) {
      // An unknown host state cannot remain ready with a stale authorization list.
      requestStop(db, job.id, "docker-local-access-reconciler");
      outcomes.push({ jobId: job.id, status: "access-update-failed",
        error: String(error?.message || error).slice(0, 256) });
    }
  }
  return outcomes;
}
