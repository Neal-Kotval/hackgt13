#!/usr/bin/env node

import { getDatabase } from "../lib/auth.mjs";
import { migrateRunBoxJobs } from "../lib/run-box-jobs.mjs";
import { assumeGpuWorkerRole, createAwsGpuProvider } from "../lib/aws-gpu-provider.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";

const mode = process.argv[2];
if (process.argv.length !== 3 || !["--once", "--loop"].includes(mode)) {
  console.error("Usage: node scripts/run-box-worker.mjs --once|--loop");
  process.exit(2);
}

async function cycle() {
  const aws = await assumeGpuWorkerRole();
  const provider = createAwsGpuProvider({ aws, subnetId: process.env.AGENTCLOUD_GPU_SUBNET_ID });
  await provider.identifyWorker();
  const db = getDatabase();
  migrateRunBoxJobs(db);
  const result = await workOneAwsGpuJob(db, provider);
  if (result) console.log(`Processed GPU job ${result.jobId}: ${result.state} (${result.evidenceRef})`);
  return result;
}

async function execute() {
  if (mode === "--once") return cycle();
  while (true) {
    try { await cycle(); }
    catch (error) { console.error(`GPU worker cycle failed: ${error.message.slice(0, 256)}`); }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

try { await execute(); }
catch (error) {
  // AWS CLI command failures can contain request details. Keep worker logs
  // bounded and do not print environment, command arguments, or credentials.
  console.error(`GPU worker failed: ${error.message.slice(0, 256)}`);
  process.exitCode = 1;
}
