#!/usr/bin/env node

import { getDatabase } from "../lib/auth.mjs";
import { migrateRunBoxJobs, requestRunBoxStop } from "../lib/run-box-jobs.mjs";
import { migrateRunBoxCleanup, reconcileAwsRunBoxes } from "../lib/run-box-reconcile.mjs";
import { migrateAwsForceClose, processAwsForceCloses } from "../lib/aws-force-close.mjs";
import { migrateAwsGpuEvidence } from "../lib/aws-gpu-evidence.mjs";
import { createAwsGpuProvider, scopedWorkerAws } from "../lib/aws-gpu-provider.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";
import { createAwsCpuProvider, discoverPublicIpv4, scanPublicHostKey } from "../lib/aws-cpu-provider.mjs";
import { applyReadyAwsCpuSshAccess } from "../lib/aws-cpu-ssh-access.mjs";
import { createAwsCpuAgentCleanup, migrateAwsCpuEnvironment, reconcileAwsCpuSshAccess, workOneAwsCpuJob } from "../lib/aws-cpu-worker.mjs";
import { createRunpodProvider } from "../lib/runpod-provider.mjs";
import { verifyRunpodSsh } from "../lib/runpod-ssh-proof.mjs";
import { migrateRunpodEvidence } from "../lib/runpod-evidence.mjs";
import { migrateRunpodCleanup, reconcileRunpodJobs } from "../lib/runpod-reconcile.mjs";
import { checkRunpodAgent, createRunpodAgentCleanup, reconcileRunpodSshAccess, workOneRunpodJob } from "../lib/runpod-worker.mjs";
import { migrateSshKeys } from "../lib/ssh-keys.mjs";
import { migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { createDockerSandboxProvider } from "../lib/docker-sandbox-provider.mjs";
import { reconcileDockerSandboxes, workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";
import { loadRunpodApiKey } from "../lib/runpod-secret.mjs";
import { checkRunpodExpiryGuard } from "./runpod-expiry-preflight.mjs";
import { localWatchdogReady } from "./runpod-local-watchdog.mjs";
import { getCodexRunnerKey } from "../lib/codex-runner-key.mjs";

// HAC-153: the install's Codex runner public key is added to every new environment so
// the backend can run `codex app-server` there over SSH. Only the public half is passed.
async function runnerKey() {
  const { publicKey, fingerprint } = await getCodexRunnerKey();
  return { publicKey, fingerprint };
}

const mode = process.argv[2];
const providerName = process.argv[3] || "aws-ec2";
const workerId = `${providerName}-worker-${process.pid}`;
if (process.argv.length > 4 || !["--once", "--loop"].includes(mode) || !["aws-ec2", "runpod", "docker-local"].includes(providerName)) {
  console.error("Usage: node scripts/run-box-worker.mjs --once|--loop [aws-ec2|runpod|docker-local]");
  process.exit(2);
}

// aws-cpu (HAC-125) runs in the same cycle when its SSH settings are present:
// AGENTCLOUD_AWS_CPU_SSH_CIDR (a public /32, or "auto" to use this host's address),
// AGENTCLOUD_AWS_CPU_SSH_KEY_FILE and AGENTCLOUD_AWS_CPU_SSH_PUBLIC_KEY (operator ed25519 key).
async function awsCycle() {
  const aws = await scopedWorkerAws();
  const subnetId = process.env.AGENTCLOUD_GPU_SUBNET_ID;
  const gpuProvider = createAwsGpuProvider({ aws, subnetId });
  // The CPU adapter reuses the GPU adapter's tagged-instance operations and also
  // revokes a job's SSH rule before terminating its instance.
  const provider = createAwsCpuProvider({ aws, subnetId });
  await provider.identifyWorker();
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateRunBoxCleanup(db);
  migrateAwsGpuEvidence(db);
  migrateAwsCpuEnvironment(db);
  const cpuConnection = { keyFile: process.env.AGENTCLOUD_AWS_CPU_SSH_KEY_FILE, publicKey: process.env.AGENTCLOUD_AWS_CPU_SSH_PUBLIC_KEY };
  const cpuConfigured = Boolean(process.env.AGENTCLOUD_AWS_CPU_SSH_CIDR);
  migrateAwsForceClose(db);
  // HAC-166: platform-admin force-close requests, before reconciliation so a stuck job
  // closes (or gets a normal stop) even while another job's cleanup is still retrying.
  for (const item of await processAwsForceCloses(db, provider, { workerId, requestStop: requestRunBoxStop }))
    console.log(`AWS force close ${item.jobId}: ${item.status}${item.error ? ` (${item.error})` : ""}`);
  const reconciled = await reconcileAwsRunBoxes(db, provider, { workerId, requestStop: requestRunBoxStop,
    cleanupAgent: cpuConfigured ? createAwsCpuAgentCleanup(db, cpuConnection) : null });
  if (reconciled.some((item) => item.status === "retry"))
    throw new Error("EC2 cleanup remains unconfirmed; refusing another allocation");
  const result = await workOneAwsGpuJob(db, gpuProvider, { workerId });
  if (result) console.log(`Processed GPU job ${result.jobId}: ${result.state} (${result.evidenceRef})`);
  if (!cpuConfigured) return result;
  const runner = await runnerKey();
  for (const item of await reconcileAwsCpuSshAccess(db, cpuConnection, { runnerKey: runner }))
    console.log(`Reconciled AWS CPU SSH access ${item.jobId}: ${item.status}`);
  // HAC-166: requester addresses registered after a box became ready (desktop app).
  for (const item of await applyReadyAwsCpuSshAccess(db, provider))
    console.log(`AWS CPU requester SSH access ${item.jobId}: ${item.status}`);
  if (result) return result;
  const configured = process.env.AGENTCLOUD_AWS_CPU_SSH_CIDR;
  const cpu = await workOneAwsCpuJob(db, provider, { workerId,
    sshSourceCidr: configured === "auto" ? await discoverPublicIpv4() : configured,
    connection: cpuConnection, probeHostKey: (host) => scanPublicHostKey(host), runnerKey: runner });
  if (cpu) console.log(`Processed CPU job ${cpu.jobId}: ${cpu.state}${cpu.retry ? ` (${cpu.reason})` : ""}`);
  return cpu;
}

// Opt-in supervised test from a developer machine: key from the environment and the
// separate scripts/runpod-local-watchdog.mjs process as the cleanup guard.
const runpodLocal = process.env.AGENTCLOUD_RUNPOD_LOCAL === "1";
const runpodGuard = runpodLocal ? async () => localWatchdogReady() : checkRunpodExpiryGuard;

async function runpodCycle() {
  const provider = createRunpodProvider({ apiKey: runpodLocal ? process.env.RUNPOD_API_KEY : await loadRunpodApiKey() });
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateRunpodEvidence(db);
  migrateRunpodCleanup(db);
  const connection = {
    keyFile: process.env.AGENTCLOUD_RUNPOD_SSH_KEY_FILE,
    publicKey: process.env.AGENTCLOUD_RUNPOD_SSH_PUBLIC_KEY,
    // Optional operator pins written by scripts/runpod-pin-host-key.mjs; they override the injected key.
    knownHostsFile: process.env.AGENTCLOUD_RUNPOD_KNOWN_HOSTS_FILE || "/var/lib/agentcloud/runpod/known_hosts",
  };
  const reconciled = await reconcileRunpodJobs(db, provider, { workerId, requestStop: requestRunBoxStop,
    checkCleanupGuard: runpodGuard, cleanupAgent: createRunpodAgentCleanup(db, connection) });
  if (reconciled.some((item) => item.status === "retry"))
    throw new Error("Runpod cleanup remains unconfirmed; refusing another allocation");
  const runner = await runnerKey();
  for (const item of await reconcileRunpodSshAccess(db, provider, connection, { runnerKey: runner }))
    console.log(`Reconciled Runpod SSH access ${item.jobId}: ${item.status}`);
  const result = await workOneRunpodJob(db, provider, { workerId, connection, verify: verifyRunpodSsh,
    checkCleanupGuard: runpodGuard, checkAgent: checkRunpodAgent, runnerKey: runner });
  if (result) console.log(`Processed Runpod job ${result.jobId}: ${result.state}${result.retry ? " (verification pending)" : ""}`);
  return result;
}

let dockerProvider;
async function dockerLocalCycle() {
  if (!dockerProvider) {
    dockerProvider = createDockerSandboxProvider();
    // Builds infra/sandbox as agentcloud-sandbox:dev when the image is absent or its build context changed.
    if ((await dockerProvider.ensureImage()).built) console.log("Built sandbox image agentcloud-sandbox:dev");
  }
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  const runner = await runnerKey();
  for (const item of await reconcileDockerSandboxes(db, dockerProvider, { runnerKey: runner }))
    console.log(`Reconciled sandbox ${item.jobId || item.containerId}: ${item.status}`);
  const result = await workOneDockerSandboxJob(db, dockerProvider, { workerId, runnerKey: runner });
  if (result) console.log(`Processed sandbox job ${result.jobId}: ${result.state}${result.port ? ` (ssh 127.0.0.1:${result.port})` : ""}`);
  return result;
}

const cycle = { "runpod": runpodCycle, "docker-local": dockerLocalCycle }[providerName] || awsCycle;
const interval = providerName === "docker-local" ? 3_000 : 15_000;

async function execute() {
  if (mode === "--once") return cycle();
  while (true) {
    try { await cycle(); }
    catch (error) { console.error(`${providerName} worker cycle failed: ${String(error.message).slice(0, 256)}`); }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

try { await execute(); }
catch (error) {
  // AWS CLI command failures can contain request details. Keep worker logs
  // bounded and do not print environment, command arguments, or credentials.
  console.error(`${providerName} worker failed: ${String(error.message).slice(0, 256)}`);
  process.exitCode = 1;
}
