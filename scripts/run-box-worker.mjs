#!/usr/bin/env node

import { getDatabase } from "../lib/auth.mjs";
import { migrateRunBoxJobs } from "../lib/run-box-jobs.mjs";
import { assumeGpuWorkerRole, createAwsGpuProvider } from "../lib/aws-gpu-provider.mjs";
import { workOneAwsGpuJob } from "../lib/aws-gpu-worker.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--once") {
  console.error("Usage: node scripts/run-box-worker.mjs --once");
  process.exit(2);
}

try {
  const aws = await assumeGpuWorkerRole();
  const provider = createAwsGpuProvider({ aws, subnetId: process.env.AGENTCLOUD_GPU_SUBNET_ID });
  await provider.identifyWorker();
  const db = getDatabase();
  migrateRunBoxJobs(db);
  const result = await workOneAwsGpuJob(db, provider);
  console.log(result ? `Processed GPU job ${result.jobId}: ${result.state} (${result.evidenceRef})` : "No GPU job available");
} catch (error) {
  // AWS CLI command failures can contain request details. Keep worker logs
  // bounded and do not print environment, command arguments, or credentials.
  console.error(`GPU worker failed: ${error.message.slice(0, 256)}`);
  process.exitCode = 1;
}
