#!/usr/bin/env node

import { getDatabase } from "../lib/auth.mjs";
import { migrateRunBoxJobs, requestRunBoxStop } from "../lib/run-box-jobs.mjs";
import { migrateRunBoxCleanup, reconcileAwsRunBoxes } from "../lib/run-box-reconcile.mjs";
import { migrateAwsGpuEvidence } from "../lib/aws-gpu-evidence.mjs";
import { assumeGpuWorkerRole, createAwsGpuProvider } from "../lib/aws-gpu-provider.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";
import { createRunpodProvider } from "../lib/runpod-provider.mjs";
import { verifyRunpodSsh } from "../lib/runpod-ssh-proof.mjs";
import { migrateRunpodEvidence } from "../lib/runpod-evidence.mjs";
import { migrateRunpodCleanup, reconcileRunpodJobs } from "../lib/runpod-reconcile.mjs";
import { reconcileRunpodSshAccess, workOneRunpodJob } from "../lib/runpod-worker.mjs";
import { migrateSshKeys } from "../lib/ssh-keys.mjs";
import { migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { createDockerSandboxProvider } from "../lib/docker-sandbox-provider.mjs";
import { reconcileDockerSandboxes, workOneDockerSandboxJob } from "../lib/docker-sandbox-worker.mjs";
import { loadRunpodApiKey } from "../lib/runpod-secret.mjs";
import { checkRunpodExpiryGuard } from "./runpod-expiry-preflight.mjs";
import { localWatchdogReady } from "./runpod-local-watchdog.mjs";

const mode = process.argv[2];
const providerName = process.argv[3] || "aws-ec2";
const workerId = `${providerName}-worker-${process.pid}`;
if (process.argv.length > 4 || !["--once", "--loop"].includes(mode) || !["aws-ec2", "runpod", "docker-local"].includes(providerName)) {
  console.error("Usage: node scripts/run-box-worker.mjs --once|--loop [aws-ec2|runpod|docker-local]");
  process.exit(2);
}

async function awsCycle() {
  const aws = await assumeGpuWorkerRole();
  const provider = createAwsGpuProvider({ aws, subnetId: process.env.AGENTCLOUD_GPU_SUBNET_ID });
  await provider.identifyWorker();
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateRunBoxCleanup(db);
  migrateAwsGpuEvidence(db);
  const reconciled = await reconcileAwsRunBoxes(db, provider, { workerId, requestStop: requestRunBoxStop });
  if (reconciled.some((item) => item.status === "retry"))
    throw new Error("GPU cleanup remains unconfirmed; refusing another allocation");
  const result = await workOneAwsGpuJob(db, provider, { workerId });
  if (result) console.log(`Processed GPU job ${result.jobId}: ${result.state} (${result.evidenceRef})`);
  return result;
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
  const reconciled = await reconcileRunpodJobs(db, provider, { workerId, requestStop: requestRunBoxStop,
    checkCleanupGuard: runpodGuard });
  if (reconciled.some((item) => item.status === "retry"))
    throw new Error("Runpod cleanup remains unconfirmed; refusing another allocation");
  const connection = {
    keyFile: process.env.AGENTCLOUD_RUNPOD_SSH_KEY_FILE,
    publicKey: process.env.AGENTCLOUD_RUNPOD_SSH_PUBLIC_KEY,
    // Optional operator pins written by scripts/runpod-pin-host-key.mjs; they override the injected key.
    knownHostsFile: process.env.AGENTCLOUD_RUNPOD_KNOWN_HOSTS_FILE || "/var/lib/agentcloud/runpod/known_hosts",
  };
  for (const item of await reconcileRunpodSshAccess(db, provider, connection))
    console.log(`Reconciled Runpod SSH access ${item.jobId}: ${item.status}`);
  const result = await workOneRunpodJob(db, provider, { workerId, connection, verify: verifyRunpodSsh,
    checkCleanupGuard: runpodGuard });
  if (result) console.log(`Processed Runpod job ${result.jobId}: ${result.state}${result.retry ? " (verification pending)" : ""}`);
  return result;
}

let dockerProvider;
async function dockerLocalCycle() {
  if (!dockerProvider) {
    dockerProvider = createDockerSandboxProvider();
    // Builds infra/sandbox as agentcloud-sandbox:dev once when the image is absent.
    if ((await dockerProvider.ensureImage()).built) console.log("Built sandbox image agentcloud-sandbox:dev");
  }
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateSshKeys(db);
  migrateRunBoxSsh(db);
  for (const item of await reconcileDockerSandboxes(db, dockerProvider))
    console.log(`Reconciled sandbox ${item.jobId || item.containerId}: ${item.status}`);
  const result = await workOneDockerSandboxJob(db, dockerProvider, { workerId });
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
