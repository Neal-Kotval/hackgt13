#!/usr/bin/env node
// Supervised end-to-end smoke test for the aws-cpu environment (HAC-125).
//
// Dry run (read-only preflight, no launch):
//   node scripts/aws-cpu-smoke.mjs --key ~/.ssh/agentcloud_smoke_ed25519
// Launch, verify over the desktop SSH path, then terminate:
//   node scripts/aws-cpu-smoke.mjs --key ~/.ssh/agentcloud_smoke_ed25519 --launch
// Another catalog machine (lib/machine-catalog.mjs), for example a GPU environment:
//   node scripts/aws-cpu-smoke.mjs --key ~/.ssh/agentcloud_smoke_ed25519 --profile aws-gpu-t4
//
// It runs the real worker (workOneAwsCpuJob) and EC2 adapter against a throwaway SQLite
// database, never the application database. AWS calls must use the scoped
// agentcloud-demo-worker role: either the current credentials are that role session, or
// they are the private staging instance role that may assume it. Root is refused.
//
// Safeguards: the instance deadline tag and on-box `shutdown -P` timer are 20 minutes
// (the expiry Lambda checks every 5 minutes; shutdown terminates the instance), the
// script aborts after 18 minutes, and cleanup runs in `finally` and on SIGINT/SIGTERM.
// Cleanup revokes the SSH rule, terminates this job's instance, and confirms EBS deletion.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { assumeGpuWorkerRole, createAwsCli } from "../lib/aws-gpu-provider.mjs";
import { createAwsCpuProvider, discoverPublicIpv4, scanPublicHostKey, validateSshSourceCidr } from "../lib/aws-cpu-provider.mjs";
import { getAwsCpuEnvironment, workOneAwsCpuJob } from "../lib/aws-cpu-worker.mjs";
import { migrateRunBoxJobs, requestRunBoxStop, saveRunBoxDecision } from "../lib/run-box-jobs.mjs";
import { getRunBoxSshEndpoint, knownHostsLine, migrateRunBoxSsh } from "../lib/run-box-ssh.mjs";
import { migrateSshKeys, normalizePublicKey, registerSshKey } from "../lib/ssh-keys.mjs";
import { findMachine, resolveDiskGib } from "../lib/machine-catalog.mjs";

const ACCOUNT = "662660921850";
const CAP_MINUTES = 20;
const ABORT_AFTER_MS = 18 * 60_000;
const DEFAULT_SUBNET = "subnet-0d76bc090d2666592";
const DEFAULT_REPO = "https://github.com/octocat/Hello-World.git";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/aws-cpu-smoke.mjs --key <ed25519 private key> [--repo <https URL>] [--cidr auto|<ip>/32] [--subnet <id>] [--profile <catalog id>] [--disk <GiB>] [--launch]");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { repo: DEFAULT_REPO, cidr: "auto", subnet: process.env.AGENTCLOUD_GPU_SUBNET_ID || DEFAULT_SUBNET, launch: false,
    profile: "aws-cpu", disk: null };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--launch") { options.launch = true; continue; }
    const value = argv[++index];
    if (!value) usage(`Missing value for ${flag}`);
    if (flag === "--key") options.key = path.resolve(value.replace(/^~(?=\/)/, os.homedir()));
    else if (flag === "--repo") options.repo = value;
    else if (flag === "--cidr") options.cidr = value;
    else if (flag === "--subnet") options.subnet = value;
    else if (flag === "--profile") options.profile = value;
    else if (flag === "--disk") options.disk = Number(value);
    else usage(`Unknown option ${flag}`);
  }
  if (!options.key) usage("--key is required");
  const machine = findMachine(options.profile);
  if (!machine) usage(`Unknown machine ${options.profile}`);
  try { options.disk = resolveDiskGib(machine, options.disk); } catch (error) { usage(error.message); }
  options.machine = machine;
  return options;
}

const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function workerAws() {
  const cli = createAwsCli();
  const identity = await cli("sts", "get-caller-identity");
  if (identity.Account !== ACCOUNT) throw new Error("AWS credentials are for another account");
  if (new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/agentcloud-demo-worker/[^/]+$`).test(identity.Arn || "")) return cli;
  // Only the private staging instance role may assume the worker role; anything else is refused there.
  return assumeGpuWorkerRole({ aws: cli, sessionName: `agentcloud-cpu-smoke-${process.pid}` });
}

function throwawayDatabase(directory, publicKey, repoUrl, profileId, diskGb) {
  const db = new Database(path.join(directory, "smoke.sqlite"));
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, emailVerified INTEGER NOT NULL);
    CREATE TABLE member (userId TEXT NOT NULL, organizationId TEXT NOT NULL, role TEXT NOT NULL);
    CREATE TABLE project_organization (project_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
    CREATE TABLE project_membership (user_id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL);`);
  migrateRunBoxJobs(db);
  migrateRunBoxSsh(db);
  migrateSshKeys(db);
  db.prepare("INSERT INTO user VALUES ('smoke-operator', 1)").run();
  db.prepare("INSERT INTO member VALUES ('smoke-operator', 'smoke-org', 'owner')").run();
  db.prepare("INSERT INTO project_organization VALUES ('smoke-project', 'smoke-org')").run();
  // The supplied key stands in for a registered desktop device key.
  registerSshKey(db, "smoke-operator", { label: "aws-cpu smoke", publicKey });
  const { job } = saveRunBoxDecision(db, {
    idempotencyKey: `aws-cpu-smoke-${Date.now()}`, resourceRequestId: `smoke-request-${Date.now()}`,
    projectId: "smoke-project", employeeId: "smoke-operator", organizationId: "smoke-org", projectRole: "owner",
    provider: "aws-ec2", profileId, diskGb, maxDurationMinutes: 60, repoUrl,
  });
  return { db, job };
}

function sanitize(text) {
  return String(text).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>").replace(/[^\w .,:()/+-]/g, "").trim().slice(0, 120);
}

function sshProbe(endpoint, keyFile, directory) {
  const knownHosts = path.join(directory, "known_hosts");
  writeFileSync(knownHosts, `${knownHostsLine(endpoint)}\n`, { mode: 0o600 });
  const script = [
    "set -u",
    "echo \"whoami: $(whoami)\"",
    "echo \"codex --version: $(codex --version 2>&1 | head -n 1)\"",
    "echo \"tmux -V: $(tmux -V 2>&1)\"",
    "echo \"codex login status: $(codex login status 2>&1 | head -n 1)\"",
  ].join("\n");
  const result = spawnSync("ssh", ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR",
    "-i", keyFile, "-p", String(endpoint.port), `${endpoint.username}@${endpoint.host}`, "bash -s"],
  { input: script, encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`SSH as ${endpoint.username} failed (exit ${result.status})`);
  for (const line of result.stdout.split("\n").filter(Boolean)) {
    const [label, ...rest] = line.split(": ");
    console.log(`  ${label}: ${sanitize(rest.join(": "))}`);
  }
  return result.stdout;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  statSync(options.key);
  const publicKey = normalizePublicKey(readFileSync(`${options.key}.pub`, "utf8"));
  const aws = await workerAws();
  const provider = createAwsCpuProvider({ aws, subnetId: options.subnet });
  log(`Identity: ${await provider.identifyWorker()}`);

  const directory = mkdtempSync(path.join(os.tmpdir(), "agentcloud-cpu-smoke-"));
  const { db, job } = throwawayDatabase(directory, publicKey, options.repo, options.machine.id, options.disk);
  const checked = await provider.preflight(job, { revokeStale: false });
  log(`Preflight passed: template ${checked.launchTemplateId}, ${checked.availabilityZone}, $${checked.hourlyComputeUsd}/h compute`);
  if (!options.launch) {
    log(`Dry run only. Re-run with --launch to allocate one ${options.machine.instanceType} (${options.disk} GiB) for at most 20 minutes.`);
    db.close();
    rmSync(directory, { recursive: true, force: true });
    return;
  }

  const sourceCidr = options.cidr === "auto" ? await discoverPublicIpv4() : validateSshSourceCidr(options.cidr);
  log(`SSH will be allowed only from ${sourceCidr}`);
  let cleaning = null;
  // Targeted by this job's tag and recorded instance ID only. The fleet reconciler is not
  // used here: with a throwaway database it would treat every other demo box as an orphan.
  const cleanup = async () => {
    cleaning ??= (async () => {
      log("Cleanup: revoking SSH access and terminating this job's instance");
      requestRunBoxStop(db, job.id, "aws-cpu-smoke");
      try { await provider.revokeSshForJob(job.id); } catch (error) { log(`SSH rule revoke failed: ${error.message}`); }
      const recorded = db.prepare("SELECT provider_resource_id FROM run_box_job WHERE id = ?").get(job.id).provider_resource_id ||
        getAwsCpuEnvironment(db, job.id)?.instance_id || null;
      let found = null;
      try { found = await provider.find(job.id); } catch (error) { log(`Tag lookup failed: ${error.message}`); }
      const ids = [...new Set([recorded, found?.InstanceId].filter(Boolean))];
      if (!ids.length) log("No instance was launched for this job (no recorded ID; tag search empty)");
      let confirmed = true;
      for (const id of ids) {
        try {
          const result = await provider.terminateInstance(id);
          log(`Instance ${id}: ${result.state}; EBS deleted: ${result.volumeIds.join(", ")}`);
        } catch (error) {
          confirmed = false;
          log(`Instance ${id}: termination not confirmed (${error.message})`);
        }
      }
      let leftover = null;
      try { leftover = await provider.find(job.id); } catch { confirmed = false; }
      let rules = [];
      try { rules = await provider.revokeSshForJob(job.id); } catch { confirmed = false; }
      log(`Final: active instance for job ${leftover ? leftover.InstanceId : "none"}; SSH rules still present: ${rules.length}`);
      if (!confirmed || leftover) {
        process.exitCode = 1;
        log("CLEANUP NOT CONFIRMED. The 20-minute on-box timer and the expiry Lambda remain as backstops; check EC2 now.");
      }
    })();
    return cleaning;
  };
  const onSignal = () => { log("Interrupted"); cleanup().finally(() => process.exit(process.exitCode || 130)); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    let ready = null;
    while (!ready) {
      if (Date.now() - startedAt > ABORT_AFTER_MS) throw new Error("Smoke test exceeded 18 minutes");
      const result = await workOneAwsCpuJob(db, provider, { workerId: "aws-cpu-smoke", connection: { keyFile: options.key, publicKey },
        sshSourceCidr: sourceCidr, capMinutes: CAP_MINUTES, probeHostKey: (host) => scanPublicHostKey(host) });
      const environment = getAwsCpuEnvironment(db, job.id);
      if (!result) throw new Error("Worker found no claimable job");
      log(`Worker: ${result.state}${result.retry ? ` (${result.reason})` : ""}${environment?.instance_id ? ` instance ${environment.instance_id}` : ""}`);
      if (result.state === "ready") ready = result;
      else await sleep(10_000);
    }
    const endpoint = getRunBoxSshEndpoint(db, job.id);
    log(`Ready: ${endpoint.username}@${endpoint.host}:${endpoint.port}, pinned ${endpoint.hostPublicKey.slice(0, 32)}...`);
    log("Desktop-path SSH check with the supplied key and pinned host key:");
    sshProbe(endpoint, options.key, directory);
    log(`Ready after ${Math.round((Date.now() - startedAt) / 1000)} s`);
  } finally {
    await cleanup();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`aws-cpu smoke failed: ${String(error.message).slice(0, 300)}`);
  process.exitCode = 1;
});
