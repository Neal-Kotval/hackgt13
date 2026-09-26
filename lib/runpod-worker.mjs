import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { authorizedKeysForProject, migrateSshKeys, normalizePublicKey } from "./ssh-keys.mjs";
import { knownHostsLine, migrateRunBoxSsh, recordRunBoxSshEndpoint } from "./run-box-ssh.mjs";
import { claimRunBoxJob, recordRunBoxAllocation, recordRunBoxRevision, releaseRunBoxLease,
  renewRunBoxLease, transitionRunBoxJob } from "./run-box-jobs.mjs";
import { runpodJobMarker, runpodPodName, RunpodAmbiguousCreateError } from "./runpod-provider.mjs";
import { saveRunpodEvidence, recordRunpodConnectionWait } from "./runpod-evidence.mjs";
import { parseScannedHostKey } from "./runpod-host-key.mjs";

// Server-owned profile. The approved decision stores this ID, never a browser-supplied GPU/image.
export const RUNPOD_PROFILE = Object.freeze({
  id: "runpod-rtx-4090", gpuId: "NVIDIA GeForce RTX 4090", label: "RTX 4090",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  cloud: "SECURE", diskGb: 50, maxHourlyUsd: 1,
});
export const RUNPOD_PROFILES = Object.freeze({
  [RUNPOD_PROFILE.id]: RUNPOD_PROFILE,
  "runpod-rtx-4000-ada": Object.freeze({
    id: "runpod-rtx-4000-ada", gpuId: "NVIDIA RTX 4000 Ada Generation", label: "RTX 4000 Ada",
    image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    cloud: "SECURE", diskGb: 50, maxHourlyUsd: 0.5,
  }),
});
function profileFor(job) {
  const profile = RUNPOD_PROFILES[job?.profile_id];
  if (!profile) throw new Error("Unapproved Runpod profile");
  return profile;
}

// Desktop sessions and the GPU proof use this non-root account. Root keeps only the
// operator key; member device keys are installed for this account only.
export const RUNPOD_SSH_USER = "agentcloud";

// Runs before the image's normal CMD (/start.sh on runpod/pytorch images). It pins the
// worker-generated ed25519 host key, restricts sshd to that key, installs authorized
// keys, then drops the secret variables from the environment passed on to /start.sh.
// start.sh only generates host keys that are missing and starts sshd when PUBLIC_KEY is set.
export const RUNPOD_START_SCRIPT = [
  "set -eu",
  "umask 077",
  "mkdir -p /etc/ssh/sshd_config.d /root/.ssh",
  "printf '%s' \"$AGENTCLOUD_SSH_HOST_KEY_B64\" | base64 -d > /etc/ssh/ssh_host_ed25519_key",
  "printf '%s\\n' \"$AGENTCLOUD_SSH_HOST_PUBLIC_KEY\" > /etc/ssh/ssh_host_ed25519_key.pub",
  "chmod 600 /etc/ssh/ssh_host_ed25519_key",
  "chmod 644 /etc/ssh/ssh_host_ed25519_key.pub",
  "printf 'HostKey /etc/ssh/ssh_host_ed25519_key\\n' > /etc/ssh/sshd_config.d/00-agentcloud-hostkey.conf",
  "chmod 644 /etc/ssh/sshd_config.d/00-agentcloud-hostkey.conf",
  "printf '%s\\n' \"$AGENTCLOUD_OPERATOR_PUBLIC_KEY\" >> /root/.ssh/authorized_keys",
  "chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys",
  `id ${RUNPOD_SSH_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${RUNPOD_SSH_USER}`,
  `install -d -m 700 -o ${RUNPOD_SSH_USER} -g ${RUNPOD_SSH_USER} /home/${RUNPOD_SSH_USER}/.ssh`,
  `printf '%s' "$AGENTCLOUD_AUTHORIZED_KEYS_B64" | base64 -d > /home/${RUNPOD_SSH_USER}/.ssh/authorized_keys`,
  `chmod 600 /home/${RUNPOD_SSH_USER}/.ssh/authorized_keys`,
  `chown ${RUNPOD_SSH_USER}:${RUNPOD_SSH_USER} /home/${RUNPOD_SSH_USER}/.ssh/authorized_keys`,
  "export PUBLIC_KEY=\"${PUBLIC_KEY:-$AGENTCLOUD_OPERATOR_PUBLIC_KEY}\"",
  "unset AGENTCLOUD_SSH_HOST_KEY_B64 AGENTCLOUD_AUTHORIZED_KEYS_B64",
  "umask 022",
  "exec /start.sh",
].join("\n");

const execFileAsync = promisify(execFile);

// Generates a per-job ed25519 host keypair in a private temporary directory that is
// removed before returning. The private key is only ever placed in the Pod create env.
export async function generateRunpodHostKey() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentcloud-hostkey-"));
  try {
    await chmod(directory, 0o700);
    const file = path.join(directory, "host_ed25519");
    await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", file], { timeout: 15_000 });
    const privateKey = await readFile(file, "utf8");
    const publicKey = normalizePublicKey(await readFile(`${file}.pub`, "utf8"));
    return { privateKey, publicKey };
  } catch {
    throw new Error("Runpod host key generation failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function migrateRunpodHostKeys(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS runpod_ssh_host_key (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
    host_public_key TEXT NOT NULL,
    authorized_keys TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
}

function hostKeyPin(db, jobId) {
  const row = db.prepare("SELECT * FROM runpod_ssh_host_key WHERE job_id = ?").get(jobId);
  return row ? { hostPublicKey: row.host_public_key, authorizedKeys: JSON.parse(row.authorized_keys) } : null;
}

function validOperatorKey(connection) {
  try { return normalizePublicKey(connection?.publicKey); } catch { return null; }
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

// A key pinned by an operator with scripts/runpod-pin-host-key.mjs (fingerprint read
// from the Runpod web terminal) wins over the injected key, e.g. when the image
// regenerated its host key. It is then what the desktop app pins as well.
export function operatorPinnedHostKey(knownHostsFile, host, port) {
  if (typeof knownHostsFile !== "string" || !knownHostsFile.startsWith("/")) return null;
  let contents;
  try { contents = readFileSync(knownHostsFile, "utf8"); } catch { return null; }
  try { return `ssh-ed25519 ${parseScannedHostKey(contents, host, port).body}`; } catch { return null; }
}

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function current(db, id) { return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id); }
function assertPodProfile(pod, job) {
  const RUNPOD_PROFILE = profileFor(job);
  requireValue(pod?.name === runpodPodName(job.id, runpodExpiryForJob(job)) &&
    pod.gpuId === RUNPOD_PROFILE.gpuId && pod.gpuCount === 1 &&
    pod.image === RUNPOD_PROFILE.image && pod.cloud === RUNPOD_PROFILE.cloud &&
    pod.diskGb === RUNPOD_PROFILE.diskGb, "Runpod Pod no longer matches approved profile");
}
export function runpodExpiryForJob(job) {
  requireValue([60, 120].includes(job.max_duration_minutes) && Number.isFinite(Date.parse(job.created_at)),
    "Invalid approved Runpod deadline");
  const deadline = Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
  // The provider name encoder rounds up; floor here so the encoded guard
  // deadline never exceeds the owner's approved duration.
  return new Date(Math.floor(deadline / 1_000) * 1_000).toISOString();
}

function approvalStillValid(db, job) {
  const decision = db.prepare("SELECT * FROM run_box_decision WHERE id = ?").get(job.decision_id);
  if (!decision || decision.outcome !== "approved" || decision.provider !== "runpod" ||
      !RUNPOD_PROFILES[job.profile_id] || decision.profile_id !== job.profile_id ||
      decision.project_id !== job.project_id || decision.max_duration_minutes !== job.max_duration_minutes ||
      ![60, 120].includes(job.max_duration_minutes) ||
      !Number.isFinite(Date.parse(job.created_at)) ||
      Date.now() >= Date.parse(job.created_at) + job.max_duration_minutes * 60_000) return false;
  let repo;
  try { repo = new URL(job.repo_url); } catch { return false; }
  if (repo.protocol !== "https:" || !repo.hostname || repo.username || repo.password || repo.search || repo.hash) return false;
  return Boolean(db.prepare(`SELECT 1 FROM project_organization po
    JOIN member m ON m.organizationId = po.organization_id AND m.userId = ?
    LEFT JOIN project_membership pm ON pm.project_id = po.project_id AND pm.user_id = m.userId
    JOIN user u ON u.id = m.userId
    WHERE po.project_id = ? AND po.organization_id = ? AND u.emailVerified = 1
      AND (m.role IN ('owner', 'admin') OR pm.role = 'owner')`).get(decision.employee_id, job.project_id, decision.organization_id));
}

// The host key is generated and pinned per job, so only the operator key pair is configured.
export function validateRunpodSshConfig(connection) {
  requireValue(connection && typeof connection.keyFile === "string" && connection.keyFile.startsWith("/") &&
    validOperatorKey(connection),
  "Runpod SSH private key file and ed25519 public key must be configured before allocation");
  try {
    requireValue(statSync(connection.keyFile).isFile(), "Runpod SSH files are unavailable");
  } catch { throw new Error("Runpod SSH files are unavailable"); }
}

export async function preflightRunpod(provider, job) {
  requireValue(job.provider === "runpod" && RUNPOD_PROFILES[job.profile_id], "Unapproved Runpod profile");
  const RUNPOD_PROFILE = profileFor(job);
  const [catalog, pods] = await Promise.all([provider.listGpuTypes(), provider.listPods()]);
  const gpu = catalog.find((entry) => entry.id === RUNPOD_PROFILE.gpuId);
  requireValue(gpu && gpu.availability && !["NONE", "UNAVAILABLE", "OUT_OF_STOCK"].includes(gpu.availability),
    `Runpod ${RUNPOD_PROFILE.label} availability is unconfirmed`);
  requireValue(Number.isFinite(gpu.secureHourlyUsd) && gpu.secureHourlyUsd > 0 &&
    gpu.secureHourlyUsd <= RUNPOD_PROFILE.maxHourlyUsd, `Runpod live Secure hourly price unavailable or above $${RUNPOD_PROFILE.maxHourlyUsd} ceiling`);
  const marker = runpodJobMarker(job.id);
  const expectedName = runpodPodName(job.id, runpodExpiryForJob(job));
  requireValue(pods.filter((pod) => pod.name.startsWith(marker)).length <= 1, "Duplicate Runpod job marker requires reconciliation");
  requireValue(!pods.some((pod) => pod.name.startsWith("agentcloud-") && pod.name !== expectedName),
    "Another managed Runpod Pod exists; reconcile it before allocation");
  return { hourlyUsd: gpu.secureHourlyUsd };
}

export async function workOneRunpodJob(db, provider, { workerId = `runpod-worker-${process.pid}`,
  connection, verify, checkSshConfig = validateRunpodSshConfig,
  checkCleanupGuard = async () => false, generateHostKey = generateRunpodHostKey } = {}) {
  requireValue(typeof verify === "function", "Runpod SSH verifier is required");
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  migrateRunpodHostKeys(db);
  const job = claimRunBoxJob(db, workerId, new Date(), 10 * 60_000, "runpod");
  if (!job) return null;
  const heartbeat = setInterval(() => {
    try { renewRunBoxLease(db, job.id, workerId, 10 * 60_000); }
    catch { clearInterval(heartbeat); }
  }, 30_000);
  heartbeat.unref();
  try {
    let fresh = current(db, job.id);
    if (fresh.stop_requested_at || fresh.state === "stopping") {
      releaseRunBoxLease(db, job.id, workerId);
      return { jobId: job.id, state: "stopping" };
    }
    if (fresh.state === "allocating") {
      requireValue(approvalStillValid(db, fresh), "Runpod approval, owner membership, profile, or deadline invalid");
      if (await checkCleanupGuard(fresh) !== true) {
        recordRunpodConnectionWait(db, job.id, "Independent Runpod cleanup guard unavailable; allocation is blocked");
        releaseRunBoxLease(db, job.id, workerId);
        return { jobId: job.id, state: "allocating", retry: true };
      }
      checkSshConfig(connection);
      await preflightRunpod(provider, fresh);
      // A Pod created by an interrupted earlier attempt already carries the pinned key
      // recorded before its POST; only a fresh create gets a newly generated key.
      let startup = {};
      if (!hostKeyPin(db, job.id) || !(await provider.findPodByJobId(job.id))) {
        const operatorKey = validOperatorKey(connection);
        const members = authorizedKeysForProject(db, fresh.project_id)
          .map(({ publicKey, fingerprint }) => ({ publicKey, fingerprint }));
        const keys = [...new Set([...(operatorKey ? [operatorKey] : []), ...members.map((key) => key.publicKey)])];
        const hostKey = await generateHostKey();
        db.prepare(`INSERT INTO runpod_ssh_host_key (job_id, host_public_key, authorized_keys, created_at)
          VALUES (?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET host_public_key = excluded.host_public_key,
          authorized_keys = excluded.authorized_keys, created_at = excluded.created_at`)
          .run(job.id, normalizePublicKey(hostKey.publicKey), JSON.stringify(members), new Date().toISOString());
        startup = {
          env: {
            AGENTCLOUD_SSH_HOST_KEY_B64: Buffer.from(hostKey.privateKey).toString("base64"),
            AGENTCLOUD_SSH_HOST_PUBLIC_KEY: normalizePublicKey(hostKey.publicKey),
            AGENTCLOUD_OPERATOR_PUBLIC_KEY: operatorKey || "",
            AGENTCLOUD_AUTHORIZED_KEYS_B64: Buffer.from(keys.map((key) => `${key}\n`).join("")).toString("base64"),
          },
          cmd: ["bash", "-c", RUNPOD_START_SCRIPT],
        };
      }
      if (await checkCleanupGuard(fresh) !== true) {
        recordRunpodConnectionWait(db, job.id, "Independent Runpod cleanup guard became unavailable before allocation");
        releaseRunBoxLease(db, job.id, workerId);
        return { jobId: job.id, state: "allocating", retry: true };
      }
      const RUNPOD_PROFILE = profileFor(fresh);
      const pod = await provider.createPod({ jobId: job.id, expiresAt: runpodExpiryForJob(fresh), gpuId: RUNPOD_PROFILE.gpuId,
        image: RUNPOD_PROFILE.image, diskGb: RUNPOD_PROFILE.diskGb, cloud: RUNPOD_PROFILE.cloud, ...startup }, {
        onBeforePost: () => db.prepare(`INSERT INTO runpod_create_attempt (job_id, attempted_at) VALUES (?, ?)
          ON CONFLICT(job_id) DO NOTHING`).run(job.id, new Date().toISOString()),
      });
      assertPodProfile(pod, fresh);
      fresh = recordRunBoxAllocation(db, job.id, workerId, "runpod", pod.id);
    }
    fresh = current(db, job.id);
    if (fresh.stop_requested_at) {
      releaseRunBoxLease(db, job.id, workerId);
      return { jobId: job.id, state: "stopping" };
    }
    requireValue(["connecting", "verifying"].includes(fresh.state), "Runpod job is not connectable");
    const pod = await provider.getPod(fresh.provider_resource_id);
    assertPodProfile(pod, fresh);
    if (!pod.ssh.direct || pod.ssh.direct.username !== "root") {
      recordRunpodConnectionWait(db, job.id, "Waiting for direct SSH endpoint and pinned host key");
      releaseRunBoxLease(db, job.id, workerId);
      return { jobId: job.id, state: fresh.state, retry: true };
    }
    const pin = hostKeyPin(db, job.id);
    if (!pin) {
      // No trust-on-first-use: a Pod without a worker-generated host key cannot be verified.
      recordRunpodConnectionWait(db, job.id, "No pinned host key was recorded for this Pod; it cannot be verified");
      releaseRunBoxLease(db, job.id, workerId);
      return { jobId: job.id, state: fresh.state, retry: true };
    }
    const operatorPin = operatorPinnedHostKey(connection?.knownHostsFile, pod.ssh.direct.host, pod.ssh.direct.port);
    const endpoint = { host: pod.ssh.direct.host, port: pod.ssh.direct.port, username: RUNPOD_SSH_USER,
      hostPublicKey: operatorPin || pin.hostPublicKey, authorizedFingerprints: pin.authorizedKeys.map((key) => key.fingerprint) };
    recordRunBoxSshEndpoint(db, job.id, endpoint);
    const operatorKey = validOperatorKey(connection);
    const authorizedKeys = [...new Set([...(operatorKey ? [operatorKey] : []), ...pin.authorizedKeys.map((key) => key.publicKey)])];
    if (fresh.state === "connecting") fresh = transitionRunBoxJob(db, job.id, "verifying", workerId,
      { evidenceRef: `runpod:${pod.id}` });
    let proof;
    try {
      proof = await withKnownHosts(knownHostsLine(endpoint), (knownHostsFile) =>
        verify(fresh, { ...pod.ssh.direct, keyFile: connection.keyFile,
          ...(operatorKey ? { publicKey: operatorKey } : {}), knownHostsFile, authorizedKeys }));
    }
    catch {
      recordRunpodConnectionWait(db, job.id, "Runpod SSH verification pending; check the pinned host key, workspace, and GPU proof");
      releaseRunBoxLease(db, job.id, workerId);
      return { jobId: job.id, state: "verifying", retry: true };
    }
    recordRunBoxRevision(db, job.id, workerId, proof.repo_sha);
    saveRunpodEvidence(db, job.id, pod.id, proof);
    fresh = current(db, job.id);
    if (fresh.stop_requested_at) {
      releaseRunBoxLease(db, job.id, workerId);
      return { jobId: job.id, state: "stopping" };
    }
    transitionRunBoxJob(db, job.id, "ready", workerId, { evidenceRef: proof.evidenceRef });
    releaseRunBoxLease(db, job.id, workerId);
    return { jobId: job.id, state: "ready", evidenceRef: proof.evidenceRef };
  } catch (error) {
    const fresh = current(db, job.id);
    if (fresh && !["stopped", "failed"].includes(fresh.state)) {
      const reason = error instanceof RunpodAmbiguousCreateError
        ? "Runpod create outcome ambiguous; reconcile marker before retry" : String(error.message).slice(0, 256);
      try {
        transitionRunBoxJob(db, job.id, "failed", workerId, { reason });
        releaseRunBoxLease(db, job.id, workerId);
      }
      catch { /* A lost lease leaves the next claimant responsible. */ }
    }
    throw error;
  } finally { clearInterval(heartbeat); }
}
