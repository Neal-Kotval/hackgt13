import { statSync } from "node:fs";
import { claimRunBoxJob, recordRunBoxAllocation, recordRunBoxRevision, releaseRunBoxLease,
  renewRunBoxLease, transitionRunBoxJob } from "./run-box-jobs.mjs";
import { runpodJobMarker, runpodPodName, RunpodAmbiguousCreateError } from "./runpod-provider.mjs";
import { saveRunpodEvidence, recordRunpodConnectionWait } from "./runpod-evidence.mjs";

// Server-owned profile. The approved decision stores this ID, never a browser-supplied GPU/image.
export const RUNPOD_PROFILE = Object.freeze({
  id: "runpod-rtx-4090", gpuId: "NVIDIA GeForce RTX 4090",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  cloud: "SECURE", diskGb: 50, maxHourlyUsd: 1,
});

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function current(db, id) { return db.prepare("SELECT * FROM run_box_job WHERE id = ?").get(id); }
function assertPodProfile(pod, job) {
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
      decision.profile_id !== RUNPOD_PROFILE.id || job.profile_id !== RUNPOD_PROFILE.id ||
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

export function validateRunpodSshConfig(connection) {
  requireValue(connection && typeof connection.keyFile === "string" && connection.keyFile.startsWith("/") &&
    typeof connection.knownHostsFile === "string" && connection.knownHostsFile.startsWith("/") &&
    /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(connection.publicKey || ""),
  "Runpod SSH key, public key, and pinned known-hosts file must be configured before allocation");
  try {
    requireValue(statSync(connection.keyFile).isFile() && statSync(connection.knownHostsFile).isFile(),
      "Runpod SSH files are unavailable");
  } catch { throw new Error("Runpod SSH files are unavailable"); }
}

export async function preflightRunpod(provider, job) {
  requireValue(job.provider === "runpod" && job.profile_id === RUNPOD_PROFILE.id, "Unapproved Runpod profile");
  const [catalog, pods] = await Promise.all([provider.listGpuTypes(), provider.listPods()]);
  const gpu = catalog.find((entry) => entry.id === RUNPOD_PROFILE.gpuId);
  requireValue(gpu && gpu.availability && !["NONE", "UNAVAILABLE", "OUT_OF_STOCK"].includes(gpu.availability),
    "Runpod RTX 4090 availability is unconfirmed");
  requireValue(Number.isFinite(gpu.secureHourlyUsd) && gpu.secureHourlyUsd > 0 &&
    gpu.secureHourlyUsd <= RUNPOD_PROFILE.maxHourlyUsd, "Runpod live Secure hourly price unavailable or above $1 ceiling");
  const marker = runpodJobMarker(job.id);
  const expectedName = runpodPodName(job.id, runpodExpiryForJob(job));
  requireValue(pods.filter((pod) => pod.name.startsWith(marker)).length <= 1, "Duplicate Runpod job marker requires reconciliation");
  requireValue(!pods.some((pod) => pod.name.startsWith("agentcloud-") && pod.name !== expectedName),
    "Another managed Runpod Pod exists; reconcile it before allocation");
  return { hourlyUsd: gpu.secureHourlyUsd };
}

export async function workOneRunpodJob(db, provider, { workerId = `runpod-worker-${process.pid}`,
  connection, verify, checkSshConfig = validateRunpodSshConfig,
  checkCleanupGuard = async () => false } = {}) {
  requireValue(typeof verify === "function", "Runpod SSH verifier is required");
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
      if (await checkCleanupGuard(fresh) !== true) {
        recordRunpodConnectionWait(db, job.id, "Independent Runpod cleanup guard became unavailable before allocation");
        releaseRunBoxLease(db, job.id, workerId);
        return { jobId: job.id, state: "allocating", retry: true };
      }
      db.prepare(`INSERT INTO runpod_create_attempt (job_id, attempted_at) VALUES (?, ?)
        ON CONFLICT(job_id) DO NOTHING`).run(job.id, new Date().toISOString());
      const pod = await provider.createPod({ jobId: job.id, expiresAt: runpodExpiryForJob(fresh), gpuId: RUNPOD_PROFILE.gpuId,
        image: RUNPOD_PROFILE.image, diskGb: RUNPOD_PROFILE.diskGb, cloud: RUNPOD_PROFILE.cloud });
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
    if (fresh.state === "connecting") fresh = transitionRunBoxJob(db, job.id, "verifying", workerId,
      { evidenceRef: `runpod:${pod.id}` });
    let proof;
    try { proof = await verify(fresh, { ...pod.ssh.direct, keyFile: connection.keyFile,
      knownHostsFile: connection.knownHostsFile, publicKey: connection.publicKey }); }
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
