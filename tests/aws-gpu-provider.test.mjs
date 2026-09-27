import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createAwsGpuProvider, assumeGpuWorkerRole, assertPaidGpuPlan, createAwsCli } from "../lib/aws-gpu-provider.mjs";

const jobId = "11111111-1111-4111-8111-111111111111";
const instanceId = "i-0123456789abcdef0";
const subnetId = "subnet-0d76bc090d2666592";
const identity = { Account: "662660921850", Arn: "arn:aws:sts::662660921850:assumed-role/agentcloud-demo-worker/test" };

function mockAws(handler) {
  return async (service, operation, ...args) => {
    if (service === "sts" && operation === "get-caller-identity") return identity;
    return handler(service, operation, args);
  };
}

test("root identity is rejected before any provider operation", async () => {
  const aws = async () => ({ Account: "662660921850", Arn: "arn:aws:iam::662660921850:root" });
  const provider = createAwsGpuProvider({ aws, subnetId });
  await assert.rejects(provider.identifyWorker(), /root and application credentials are rejected/);
  await assert.rejects(provider.inspect({ id: jobId }), /root and application credentials are rejected/);
  await assert.rejects(assumeGpuWorkerRole({ aws }), /root credentials are rejected/);
});

test("G6 requires Paid plan even when Free credits and quota remain", async () => {
  const calls = [];
  const aws = mockAws((service, operation) => {
    calls.push(`${service}:${operation}`);
    if (operation === "get-account-plan-state") return {
      accountId: identity.Account, accountPlanType: "FREE", accountPlanStatus: "ACTIVE",
      accountPlanRemainingCredits: { unit: "USD", amount: 160 }, accountPlanExpirationDate: "2030-01-01T00:00:00Z",
    };
    if (operation === "describe-instances") return { Reservations: [] };
    return {};
  });
  const provider = createAwsGpuProvider({ aws, subnetId, now: () => new Date("2026-09-26T00:00:00Z") });
  await assert.rejects(provider.allocate({ id: jobId, provider: "aws-ec2", max_duration_minutes: 60, project_id: "project-1" }),
    /requires an active AWS Paid plan; current plan is FREE/);
  assert.ok(!calls.includes("ec2:run-instances"));
  assert.ok(!calls.includes("ec2:describe-launch-template-versions"));
});

test("Paid plan still requires credits and a sufficient runtime window", () => {
  const plan = { accountId: identity.Account, accountPlanType: "PAID", accountPlanStatus: "ACTIVE",
    accountPlanRemainingCredits: { unit: "USD", amount: 5 }, accountPlanExpirationDate: "2026-09-26T04:00:00Z" };
  assert.doesNotThrow(() => assertPaidGpuPlan(plan, new Date("2026-09-26T00:00:00Z")));
  assert.throws(() => assertPaidGpuPlan({ ...plan, accountPlanRemainingCredits: { unit: "USD", amount: 0 } }, new Date("2026-09-26T00:00:00Z")),
    /credits unavailable/);
  assert.throws(() => assertPaidGpuPlan({ ...plan, accountPlanExpirationDate: "2026-09-26T02:00:00Z" }, new Date("2026-09-26T00:00:00Z")),
    /runtime window unavailable/);
});

test("AWS CLI errors preserve only operation, code, and known Free Tier rejection", async () => {
  const run = async () => { const error = new Error("aws --cli-input-json secret-value");
    error.stderr = "An error occurred (Client.InvalidParameterCombination) when calling the RunInstances operation: The instance type 'g6.xlarge' is not eligible for Free Tier; secret-value";
    throw error; };
  const aws = createAwsCli({ run, env: {} });
  await assert.rejects(aws("ec2", "run-instances", "--cli-input-json", "secret-value"), (error) => {
    assert.equal(error.message, "AWS ec2:run-instances Client.InvalidParameterCombination: g6.xlarge is not eligible for Free Tier");
    assert.doesNotMatch(error.message, /secret-value/);
    return true;
  });
});

test("managed volume inventory includes orphan volumes", async () => {
  const volume = { VolumeId: "vol-0123456789abcdef0", Tags: [{ Key: "Project", Value: "AgentCloudDemo" }] };
  const aws = mockAws((service, operation, args) => {
    assert.equal(`${service}:${operation}`, "ec2:describe-volumes");
    assert.ok(args.includes("Name=tag:AgentCloudAutoExpire,Values=true"));
    return { Volumes: [volume] };
  });
  const provider = createAwsGpuProvider({ aws, subnetId });
  assert.deepEqual(await provider.listManagedVolumes(), [volume]);
});

test("retry discovers tagged instance before attempting a new launch", async () => {
  const calls = [];
  const aws = mockAws((service, operation) => {
    calls.push(`${service}:${operation}`);
    if (operation === "describe-instances") return { Reservations: [{ Instances: [{ InstanceId: instanceId, Tags: [{ Key: "AgentCloudJobId", Value: jobId }] }] }] };
    throw new Error(`Unexpected ${operation}`);
  });
  const provider = createAwsGpuProvider({ aws, subnetId });
  const result = await provider.allocate({ id: jobId, provider: "aws-ec2", max_duration_minutes: 60, project_id: "project-1" });
  assert.equal(result.InstanceId, instanceId);
  assert.deepEqual(calls, ["ec2:describe-instances"]);
});

test("SSM verification requires non-root workspace and a CUDA workload marker", async () => {
  const sent = [];
  const aws = mockAws((service, operation, args) => {
    if (operation === "describe-instance-information") return { InstanceInformationList: [{ InstanceId: instanceId, PingStatus: "Online" }] };
    if (operation === "send-command") {
      const payload = JSON.parse(args.at(-1));
      sent.push(payload);
      return { Command: { CommandId: "cmd-1" } };
    }
    if (operation === "get-command-invocation") return { Status: "Success", ResponseCode: 0, StandardOutputContent:
      `AGENTCLOUD_EVIDENCE=${JSON.stringify({ uid: 1000, workspace: `/home/ec2-user/agentcloud/${jobId}`,
        repo_sha: "a".repeat(40), gpu_device: "NVIDIA L4", nvidia_probe: "GPU 0: NVIDIA L4",
        workload_value: 4, correct: true, cpu_ms: 1.25, gpu_ms: 0.75, elapsed_ms: 2230 })}\n` };
    throw new Error(`Unexpected ${operation}`);
  });
  const provider = createAwsGpuProvider({ aws, subnetId, sleep: async () => {} });
  const evidence = await provider.verify(instanceId, { id: jobId, repo_url: "https://github.com/example/repo.git", repo_revision: null });
  assert.equal(evidence.evidenceRef, "ssm:cmd-1");
  assert.equal(evidence.remoteAccount, "ec2-user");
  assert.equal(evidence.repositoryRevision, "a".repeat(40));
  assert.equal(evidence.gpuDevice, "NVIDIA L4");
  assert.equal(evidence.workloadValue, 4);
  assert.equal(evidence.cpuMs, 1.25);
  assert.equal(evidence.gpuMs, 0.75);
  assert.match(sent[0].Parameters.commands.join("\n"), /sudo -u ec2-user/);
  assert.match(sent[0].Parameters.commands.join("\n"), /\/opt\/pytorch\/bin\/python/);
  assert.match(sent[0].Parameters.commands.join("\n"), /git\("clone"/);
  assert.match(sent[0].Parameters.commands.join("\n"), /torch\.cuda\.is_available/);
  const script = sent[0].Parameters.commands[0].split("<<'PY'\n")[1].split("\nPY")[0];
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: script });
});

test("SSM success without repository and CUDA evidence is rejected", async () => {
  const aws = mockAws((service, operation) => {
    if (operation === "describe-instance-information") return { InstanceInformationList: [{ InstanceId: instanceId, PingStatus: "Online" }] };
    if (operation === "send-command") return { Command: { CommandId: "11111111-1111-4111-8111-111111111111" } };
    if (operation === "get-command-invocation") return { Status: "Success", ResponseCode: 0, StandardOutputContent: "nvidia-smi available" };
    throw new Error(`Unexpected ${operation}`);
  });
  const provider = createAwsGpuProvider({ aws, subnetId, sleep: async () => {} });
  await assert.rejects(provider.verify(instanceId, { id: jobId, repo_url: "https://github.com/example/repo.git", repo_revision: null }),
    /evidence missing/);
});

test("termination does not succeed until the root volume is gone", async () => {
  let volumeLookups = 0;
  const aws = mockAws((service, operation) => {
    if (operation === "describe-instances") return { Reservations: [{ Instances: [{
      InstanceId: instanceId, State: { Name: "terminated" },
      Tags: [{ Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" }],
      BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-0123456789abcdef0" } }],
    }] }] };
    if (operation === "describe-volumes") {
      volumeLookups++;
      if (volumeLookups === 1) return { Volumes: [{ State: "available" }] };
      throw new Error("InvalidVolume.NotFound");
    }
    throw new Error(`Unexpected ${operation}`);
  });
  const provider = createAwsGpuProvider({ aws, subnetId, sleep: async () => {} });
  const evidence = await provider.terminateInstance(instanceId);
  assert.equal(volumeLookups, 2);
  assert.deepEqual(evidence.volumeIds, ["vol-0123456789abcdef0"]);
  assert.equal(evidence.state, "terminated");
});

test("scopedWorkerAws uses an existing worker-role session, assumes from staging, and refuses root", async () => {
  const { scopedWorkerAws } = await import("../lib/aws-gpu-provider.mjs");
  const cli = (arn) => async () => ({ Account: "662660921850", Arn: arn });
  let assumed = 0;
  const assume = async () => { assumed++; return "assumed-cli"; };
  const worker = cli("arn:aws:sts::662660921850:assumed-role/agentcloud-demo-worker/botocore-session-1");
  assert.equal(await scopedWorkerAws({ aws: worker, assume }), worker);
  assert.equal(assumed, 0);
  assert.equal(await scopedWorkerAws({ aws: cli("arn:aws:sts::662660921850:assumed-role/agentcloud-auth-staging/i-0a2e"), assume }), "assumed-cli");
  const rootAssume = async () => { throw new Error("root credentials are rejected"); };
  await assert.rejects(scopedWorkerAws({ aws: cli("arn:aws:iam::662660921850:root"), assume: rootAssume }), /root credentials are rejected/);
  await assert.rejects(scopedWorkerAws({ aws: async () => ({ Account: "111111111111", Arn: "x" }), assume }), /another account/);
});
