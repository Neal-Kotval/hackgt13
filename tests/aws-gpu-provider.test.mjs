import test from "node:test";
import assert from "node:assert/strict";
import { createAwsGpuProvider, assumeGpuWorkerRole } from "../lib/aws-gpu-provider.mjs";

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
    if (operation === "get-command-invocation") return { Status: "Success", ResponseCode: 0, StandardOutputContent: "GPU 0\nAGENTCLOUD_CUDA_OK 4\nAGENTCLOUD_WORKSPACE_OK\n" };
    throw new Error(`Unexpected ${operation}`);
  });
  const provider = createAwsGpuProvider({ aws, subnetId, sleep: async () => {} });
  const evidence = await provider.verify(instanceId, jobId);
  assert.equal(evidence.evidenceRef, "ssm:cmd-1");
  assert.equal(evidence.remoteAccount, "ec2-user");
  assert.match(sent[0].Parameters.commands.join("\n"), /sudo -u ec2-user/);
  assert.match(sent[0].Parameters.commands.join("\n"), /torch\.cuda\.is_available/);
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
