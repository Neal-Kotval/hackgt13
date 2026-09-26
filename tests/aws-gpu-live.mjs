import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";

// Live, billable smoke test. Run explicitly after Terraform, the private app,
// and the scoped worker service are deployed. It is never part of npm test.
const base = process.env.AGENTCLOUD_GPU_E2E_BASE || "http://127.0.0.1:3000";
const projectId = process.env.AGENTCLOUD_GPU_E2E_PROJECT_ID;
const email = process.env.AGENTCLOUD_GPU_E2E_EMAIL;
const stagingInstanceId = process.env.AGENTCLOUD_GPU_E2E_STAGING_INSTANCE_ID;
if (!projectId || !email || !/^i-[0-9a-f]+$/.test(stagingInstanceId || "") ||
    !/^http:\/\/127\.0\.0\.1:3000$/.test(base))
  throw new Error("Set project ID, email, and staging instance ID; use the private localhost:3000 SSM tunnel");

const password = await new Promise((resolve, reject) => {
  let line = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    line += chunk;
    if (line.includes("\n")) {
      process.stdin.pause();
      resolve(line.split("\n", 1)[0].trim());
    }
  });
  process.stdin.on("end", () => reject(new Error("Password required on stdin")));
});
if (!password) throw new Error("Password required on stdin");

function aws(...args) {
  return new Promise((resolve, reject) => {
    execFile("aws", [...args, "--output", "json"], { timeout: 45_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(JSON.parse(stdout));
    });
  });
}

async function jobs(page) {
  const response = await page.request.get(`${base}/api/run-boxes?projectId=${encodeURIComponent(projectId)}`);
  assert.equal(response.status(), 200, "Job list must be available to the signed-in owner");
  return (await response.json()).jobs;
}

async function pollJob(page, id, predicate, limitMs) {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    const job = (await jobs(page)).find((item) => item.id === id);
    if (job && predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for GPU job ${id}`);
}

async function assertReleased(instanceId) {
  const response = await aws("ec2", "describe-instances", "--region", "us-east-1", "--instance-ids", instanceId);
  const instance = response.Reservations?.flatMap((item) => item.Instances || []).find((item) => item.InstanceId === instanceId);
  assert.equal(instance?.State?.Name, "terminated", "EC2 must report termination");
  const volumes = await aws("ec2", "describe-volumes", "--region", "us-east-1", "--filters", "Name=tag:Project,Values=AgentCloudDemo");
  assert.equal(volumes.Volumes?.length || 0, 0, "Demo EBS volumes must be deleted");
}

async function readVerification(jobId) {
  assert.match(jobId, /^[0-9a-f-]{36}$/);
  const command = `python3 - <<'PY'\nimport json, sqlite3\ndb = sqlite3.connect('/var/lib/agentcloud/auth.sqlite')\ndb.row_factory = sqlite3.Row\nrow = db.execute('SELECT * FROM aws_gpu_verification WHERE job_id = ?', ('${jobId}',)).fetchone()\nprint(json.dumps(dict(row) if row else None))\nPY`;
  const sent = await aws("ssm", "send-command", "--region", "us-east-1", "--instance-ids", stagingInstanceId,
    "--document-name", "AWS-RunShellScript", "--parameters", JSON.stringify({ commands: [command] }));
  const commandId = sent.Command?.CommandId;
  assert.ok(commandId, "SSM evidence read must return a command ID");
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    let result;
    try {
      result = await aws("ssm", "get-command-invocation", "--region", "us-east-1", "--command-id", commandId,
        "--instance-id", stagingInstanceId);
    } catch (error) {
      if (String(error).includes("InvocationDoesNotExist")) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw error;
    }
    if (result.Status === "Success") return JSON.parse(result.StandardOutputContent.trim());
    if (["Failed", "Cancelled", "TimedOut"].includes(result.Status))
      throw new Error(`SSM evidence read failed: ${result.Status}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out reading GPU verification evidence");
}

let browser;
let jobId;
let page;
let completed = false;
try {
  const identity = await aws("sts", "get-caller-identity");
  assert.equal(identity.Account, "662660921850");
  const live = await fetch(`${base}/sign-in`, { signal: AbortSignal.timeout(5000) });
  assert.equal(live.status, 200, "Private SSM tunnel must serve sign-in");
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/sign-in`);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(`${base}/organizations`);
  const employeeResponse = await page.request.get(`${base}/api/employee`);
  assert.equal(employeeResponse.status(), 200);
  const employee = await employeeResponse.json();
  assert.equal(employee.email, email);
  assert.equal(employee.memberships.find((item) => item.projectId === projectId)?.role, "owner");

  const purpose = `Live bounded GPU e2e ${randomUUID()}`;
  const requestResponse = await page.request.post(`${base}/api/resources`, {
    data: { type: "requestResource", projectId, kind: "gpu", gpuProfileId: "g6-l4-small", durationHours: 1, purpose },
  });
  assert.equal(requestResponse.status(), 200);
  const resourceRequest = (await requestResponse.json()).request;
  assert.equal(resourceRequest.decision.status, "not_evaluated");

  const anonymous = await browser.newContext();
  const denied = await anonymous.request.post(`${base}/api/run-boxes`, {
    data: { projectId, resourceRequestId: resourceRequest.id, idempotencyKey: `gpu-${resourceRequest.id}` },
  });
  assert.equal(denied.status(), 401, "Anonymous approval must be denied");
  await anonymous.close();
  assert.equal((await jobs(page)).some((item) => item.resource_request_id === resourceRequest.id), false);

  await page.goto(`${base}/projects/${projectId}/requests`);
  const card = page.getByRole("article").filter({ hasText: purpose });
  await card.getByRole("button", { name: "Approve and queue GPU" }).click();
  await card.getByText("Permission: approved").waitFor();
  const approved = (await jobs(page)).find((item) => item.resource_request_id === resourceRequest.id);
  assert.ok(approved?.id);
  jobId = approved.id;
  console.log(`Approved GPU job ${jobId}; waiting for the scoped worker`);

  const ready = await pollJob(page, jobId, (job) => ["ready", "failed", "stopping", "stopped"].includes(job.state), 20 * 60_000);
  assert.equal(ready.state, "ready", `GPU job did not become ready: ${ready.state}`);
  assert.match(ready.provider_resource_id, /^i-[0-9a-f]+$/);
  assert.match(ready.repo_revision || "", /^[0-9a-f]{40}$/);
  assert.equal(ready.provider, "aws-ec2");
  const evidence = await readVerification(jobId);
  assert.equal(evidence.instance_id, ready.provider_resource_id);
  assert.equal(evidence.repo_revision, ready.repo_revision);
  assert.equal(evidence.remote_account, "ec2-user");
  assert.ok(evidence.remote_uid > 0);
  assert.match(evidence.gpu_device, /NVIDIA|L4/i);
  assert.equal(evidence.cuda_sum, 4);
  assert.ok(evidence.cpu_ms > 0 && evidence.gpu_ms > 0, "CPU and CUDA workloads must both execute");
  assert.equal(evidence.exit_code, 0);
  assert.match(evidence.output_sha256, /^[0-9a-f]{64}$/);
  await page.reload();
  await card.getByText("ready", { exact: true }).waitFor();
  await card.getByRole("button", { name: "Request stop" }).click();
  const stopped = await pollJob(page, jobId, (job) => job.state === "stopped", 12 * 60_000);
  assert.ok(stopped.stop_requested_at);
  await assertReleased(stopped.provider_resource_id);
  assert.deepEqual(errors, []);
  completed = true;
  console.log(`PASS live GPU lifecycle: job ${jobId}, instance ${stopped.provider_resource_id}, repo ${stopped.repo_revision}, device ${evidence.gpu_device}, EC2 terminated, EBS deleted`);
} finally {
  if (jobId && !completed && page) {
    try {
      const current = (await jobs(page)).find((item) => item.id === jobId);
      if (current && current.state !== "stopped") {
        await page.request.post(`${base}/api/run-boxes/${jobId}/stop`, { data: { projectId } });
        console.error(`Requested cleanup for incomplete GPU job ${jobId}`);
      }
    } catch { console.error(`Could not confirm cleanup request for GPU job ${jobId}`); }
  }
  await browser?.close();
}
