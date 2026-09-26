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
import { workOneRunpodJob } from "../lib/runpod-worker.mjs";

const mode = process.argv[2];
const providerName = process.argv[3] || "aws-ec2";
const workerId = `${providerName}-worker-${process.pid}`;
if (process.argv.length > 4 || !["--once", "--loop"].includes(mode) || !["aws-ec2", "runpod"].includes(providerName)) {
  console.error("Usage: node scripts/run-box-worker.mjs --once|--loop [aws-ec2|runpod]");
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

async function runpodCycle() {
  const provider = createRunpodProvider({ apiKey: process.env.RUNPOD_API_KEY });
  const db = getDatabase();
  migrateRunBoxJobs(db);
  migrateRunpodEvidence(db);
  migrateRunpodCleanup(db);
  const reconciled = await reconcileRunpodJobs(db, provider, { workerId, requestStop: requestRunBoxStop });
  if (reconciled.some((item) => item.status === "retry"))
    throw new Error("Runpod cleanup remains unconfirmed; refusing another allocation");
  const connection = {
    keyFile: process.env.AGENTCLOUD_RUNPOD_SSH_KEY_FILE,
    publicKey: process.env.AGENTCLOUD_RUNPOD_SSH_PUBLIC_KEY,
  };
  const result = await workOneRunpodJob(db, provider, { workerId, connection, verify: verifyRunpodSsh });
  if (result) console.log(`Processed Runpod job ${result.jobId}: ${result.state}${result.retry ? " (verification pending)" : ""}`);
  return result;
}

const cycle = providerName === "runpod" ? runpodCycle : awsCycle;

async function execute() {
  if (mode === "--once") return cycle();
  while (true) {
    try { await cycle(); }
    catch (error) { console.error(`${providerName} worker cycle failed: ${String(error.message).slice(0, 256)}`); }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

try { await execute(); }
catch (error) {
  // AWS CLI command failures can contain request details. Keep worker logs
  // bounded and do not print environment, command arguments, or credentials.
  console.error(`${providerName} worker failed: ${String(error.message).slice(0, 256)}`);
  process.exitCode = 1;
}
