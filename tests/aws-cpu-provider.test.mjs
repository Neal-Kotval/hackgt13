import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  agentCheckScript, buildCpuUserData, createAwsCpuProvider, CODEX_VERSION, HOST_KEY_READBACK, NODE_SHA256,
  parseAgentCheck, parseHostKeyReadback, validateSshSourceCidr,
} from "../lib/aws-cpu-provider.mjs";
import { ed25519PublicKey } from "./ssh-key-fixture.mjs";

const ACCOUNT = "662660921850";
const jobId = "22222222-2222-4222-8222-222222222222";
const instanceId = "i-0abcdef0123456789";
const subnetId = "subnet-0d76bc090d2666592";
const identity = { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/agentcloud-demo-worker/test` };

function job(extra = {}) {
  return { id: jobId, provider: "aws-ec2", profile_id: "aws-cpu", project_id: "project-1", max_duration_minutes: 60,
    created_at: "2026-09-26T12:00:00.000Z", repo_url: "https://github.com/example/repo.git", repo_revision: null, ...extra };
}

function templateData(overrides = {}) {
  return {
    ImageId: "ami-0fef201115eefe936", InstanceType: "t3.medium", InstanceInitiatedShutdownBehavior: "terminate",
    MetadataOptions: { HttpTokens: "required" },
    IamInstanceProfile: { Arn: `arn:aws:iam::${ACCOUNT}:instance-profile/agentcloud-demo-instance` },
    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { Encrypted: true, DeleteOnTermination: true } }],
    SecurityGroupIds: ["sg-0446333335c7914f6", "sg-0c9d"],
    TagSpecifications: ["instance", "volume"].map((ResourceType) => ({ ResourceType,
      Tags: [{ Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" }] })),
    ...overrides,
  };
}

// A fake AWS CLI for a healthy, applied account. `overrides[operation]` replaces a response.
function fakeAws({ overrides = {}, rules = [], calls = [] } = {}) {
  const price = JSON.stringify({ terms: { OnDemand: { t: { priceDimensions: { d: { unit: "Hrs", pricePerUnit: { USD: "0.0416000000" } } } } } } });
  const responses = {
    "sts:get-caller-identity": identity,
    "ec2:describe-launch-templates": { LaunchTemplates: [{ LaunchTemplateId: "lt-0cpu" }] },
    "ec2:describe-launch-template-versions": { LaunchTemplateVersions: [{ LaunchTemplateData: templateData() }] },
    "freetier:get-account-plan-state": { accountId: ACCOUNT, accountPlanType: "PAID", accountPlanStatus: "ACTIVE" },
    "pricing:get-products": { PriceList: [price] },
    "budgets:describe-budget": { Budget: { BudgetLimit: { Amount: "25.0", Unit: "USD" } } },
    "lambda:get-function-configuration": { State: "Active", LastUpdateStatus: "Successful", FunctionArn: "arn:fn",
      Environment: { Variables: { MAX_AGE_MINUTES: "120" } } },
    "events:describe-rule": { State: "ENABLED", ScheduleExpression: "rate(5 minutes)" },
    "events:list-targets-by-rule": { Targets: [{ Arn: "arn:fn" }] },
    "ec2:describe-subnets": { Subnets: [{ SubnetId: subnetId, State: "available", MapPublicIpOnLaunch: true, AvailabilityZone: "us-east-1a" }] },
    "ec2:describe-instance-type-offerings": { InstanceTypeOfferings: [{ Location: "us-east-1a" }] },
    "ec2:describe-instances": { Reservations: [] },
    "ec2:describe-images": { Images: [{ State: "available", Architecture: "x86_64", RootDeviceName: "/dev/xvda" }] },
    "ec2:describe-security-groups": (args) => args.includes("--filters")
      ? { SecurityGroups: [{ GroupId: "sg-0c9d", GroupName: "agentcloud-demo-cpu-ssh", IpPermissions: [] }] }
      : { SecurityGroups: [{ GroupId: "sg-0446333335c7914f6", GroupName: "agentcloud-demo-ssm", IpPermissions: [] },
        { GroupId: "sg-0c9d", GroupName: "agentcloud-demo-cpu-ssh", IpPermissions: [] }] },
    "ec2:describe-security-group-rules": () => ({ SecurityGroupRules: rules }),
    "ec2:revoke-security-group-ingress": (args) => {
      const ids = args.slice(args.indexOf("--security-group-rule-ids") + 1);
      for (const id of ids) rules.splice(rules.findIndex((rule) => rule.SecurityGroupRuleId === id), 1);
      return { Return: true };
    },
    "ec2:authorize-security-group-ingress": (args) => {
      const input = JSON.parse(args.at(-1));
      const rule = { SecurityGroupRuleId: "sgr-0e1f", IsEgress: false, IpProtocol: "tcp", FromPort: 22, ToPort: 22,
        CidrIpv4: input.IpPermissions[0].IpRanges[0].CidrIp, Tags: input.TagSpecifications[0].Tags };
      rules.push(rule);
      return { Return: true, SecurityGroupRules: [rule] };
    },
    "ec2:run-instances": (args) => {
      const input = JSON.parse(args.at(-1));
      return { Instances: [{ InstanceId: instanceId, Tags: input.TagSpecifications[0].Tags }] };
    },
    ...overrides,
  };
  return async (service, operation, ...args) => {
    const key = `${service}:${operation}`;
    calls.push({ key, args });
    const response = responses[key];
    if (response === undefined) throw new Error(`Unexpected ${key}`);
    return typeof response === "function" ? response(args) : response;
  };
}

test("SSH source must be one public IPv4 address", () => {
  assert.equal(validateSshSourceCidr("203.0.113.7/32"), "203.0.113.7/32");
  for (const bad of ["203.0.113.0/24", "10.0.0.5/32", "192.168.1.2/32", "127.0.0.1/32", "169.254.169.254/32", "0.0.0.0/0", "2001:db8::1/128", "", null])
    assert.throws(() => validateSshSourceCidr(bad), /public IPv4 \/32/);
});

test("user data carries only public data, pins versions, and sets a self-destruct timer", () => {
  const key = ed25519PublicKey();
  const script = buildCpuUserData({ jobId, authorizedKeys: [key, key], lifetimeMinutes: 20 });
  execFileSync("bash", ["-n"], { input: script });
  assert.doesNotMatch(script, /PRIVATE KEY/);
  assert.match(script, /shutdown -P \+20 /);
  assert.match(script, new RegExp(`@openai/codex@${CODEX_VERSION.replaceAll(".", "\\.")}`));
  assert.ok(script.includes(NODE_SHA256));
  assert.match(script, /ssh-keygen -q -t ed25519 -N '' -C '' -f \/etc\/ssh\/ssh_host_ed25519_key/);
  assert.match(script, /PasswordAuthentication no/);
  assert.match(script, /PermitRootLogin no/);
  assert.match(script, /AuthorizedKeysCommand none/);
  assert.match(script, /AllowUsers agentcloud/);
  assert.match(script, /cli_auth_credentials_store = "file"/);
  assert.match(script, /chmod 600 \/home\/agentcloud\/\.codex\/config\.toml/);
  assert.match(script, /bootstrap\.done/);
  const encoded = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > \/home\/agentcloud\/\.ssh\/authorized_keys/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString(), `${key}\n`);
  assert.throws(() => buildCpuUserData({ jobId, authorizedKeys: [], lifetimeMinutes: 20 }), /authorized public key/);
  assert.throws(() => buildCpuUserData({ jobId, authorizedKeys: [key], lifetimeMinutes: 121 }), /self-destruct/);
  execFileSync("bash", ["-n"], { input: HOST_KEY_READBACK });
});

test("host key readback reports bootstrap progress and requires sshd to serve the key", () => {
  const key = ed25519PublicKey();
  assert.deepEqual(parseHostKeyReadback("AGENTCLOUD_BOOTSTRAP=pending:codex\n"), { state: "pending", step: "codex" });
  assert.deepEqual(parseHostKeyReadback("AGENTCLOUD_BOOTSTRAP=failed:node\n"), { state: "failed", step: "node" });
  assert.deepEqual(parseHostKeyReadback(`AGENTCLOUD_BOOTSTRAP=done\nAGENTCLOUD_HOSTKEY=${key}\nAGENTCLOUD_SCANNED=${key}\n`),
    { state: "ready", hostPublicKey: key });
  assert.throws(() => parseHostKeyReadback(`AGENTCLOUD_BOOTSTRAP=done\nAGENTCLOUD_HOSTKEY=${key}\nAGENTCLOUD_SCANNED=${ed25519PublicKey()}\n`),
    /does not serve/);
});

test("agent check script parses and its proof requires the pinned tools", () => {
  execFileSync("bash", ["-n"], { input: agentCheckScript(job()) });
  const proof = { account: "agentcloud", uid: 1001, workspace: `/home/agentcloud/agentcloud/${jobId}/repo`, repo_sha: "c".repeat(40),
    codex: `codex-cli ${CODEX_VERSION}`, tmux: "tmux 3.2a", git: "git version 2.47.1", node: "v22.23.3" };
  const line = (value) => `AGENTCLOUD_EVIDENCE=${JSON.stringify(value)}\n`;
  assert.equal(parseAgentCheck(line(proof), job()).repo_sha, "c".repeat(40));
  assert.throws(() => parseAgentCheck(line({ ...proof, codex: "codex-cli 0.156.0" }), job()), /incomplete/);
  assert.throws(() => parseAgentCheck(line({ ...proof, account: "root", uid: 0 }), job()), /incomplete/);
  assert.throws(() => parseAgentCheck(line(proof), job({ repo_revision: "d".repeat(40) })), /incomplete/);
});

test("root identity is rejected before any CPU operation", async () => {
  const aws = async () => ({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:root` });
  const provider = createAwsCpuProvider({ aws, subnetId });
  await assert.rejects(provider.allocate(job(), { authorizedKeys: [ed25519PublicKey()] }), /root and application credentials are rejected/);
  await assert.rejects(provider.authorizeSsh(job(), "203.0.113.7/32"), /root and application credentials are rejected/);
});

test("allocation revokes stale SSH rules and launches with tagged deadline and public-only user data", async () => {
  const calls = [];
  const rules = [{ SecurityGroupRuleId: "sgr-0a1d", IsEgress: false, CidrIpv4: "198.51.100.1/32", Tags: [{ Key: "AgentCloudJobId", Value: "old" }] }];
  const key = ed25519PublicKey();
  const provider = createAwsCpuProvider({ aws: fakeAws({ rules, calls }), subnetId, now: () => new Date("2026-09-26T12:10:00Z") });
  const instance = await provider.allocate(job(), { authorizedKeys: [key], capMinutes: 20 });
  assert.equal(instance.InstanceId, instanceId);
  assert.equal(rules.length, 0);
  const launch = JSON.parse(calls.find((call) => call.key === "ec2:run-instances").args.at(-1));
  assert.equal(launch.ClientToken, jobId);
  assert.deepEqual(launch.LaunchTemplate, { LaunchTemplateId: "lt-0cpu", Version: "$Default" });
  const tags = Object.fromEntries(launch.TagSpecifications[0].Tags.map(({ Key, Value }) => [Key, Value]));
  assert.equal(tags.AgentCloudExpiresAt, "2026-09-26T12:30:00.000Z");
  assert.equal(tags.AgentCloudProfile, "aws-cpu");
  const userData = Buffer.from(launch.UserData, "base64").toString();
  assert.match(userData, /shutdown -P \+20 /);
  assert.ok(userData.includes(Buffer.from(`${key}\n`).toString("base64")));
  assert.doesNotMatch(userData, /PRIVATE KEY/);
});

test("preflight refuses unsafe templates, a Free plan, and another active instance", async () => {
  const cases = [
    [{ "ec2:describe-launch-template-versions": { LaunchTemplateVersions: [{ LaunchTemplateData: templateData({ InstanceInitiatedShutdownBehavior: "stop" }) }] } }, /terminate on instance shutdown/],
    [{ "ec2:describe-launch-template-versions": { LaunchTemplateVersions: [{ LaunchTemplateData: templateData({ UserData: "abc" }) }] } }, /must not carry user data/],
    [{ "freetier:get-account-plan-state": { accountId: ACCOUNT, accountPlanType: "FREE", accountPlanStatus: "ACTIVE" } }, /requires an active AWS Paid plan/],
    [{ "ec2:describe-instances": (args) => args.some((arg) => arg.startsWith("Name=tag:AgentCloudJobId")) ? { Reservations: [] }
      : { Reservations: [{ Instances: [{ InstanceId: "i-0other", Tags: [] }] }] } }, /Another demo instance is active/],
    [{ "ec2:describe-security-groups": (args) => ({ SecurityGroups: args.includes("--filters") ? [] : [
      { GroupName: "agentcloud-demo-ssm", IpPermissions: [{ FromPort: 22 }] }, { GroupName: "agentcloud-demo-cpu-ssh", IpPermissions: [] }] }) },
    /SSM group \(no inbound\)/],
  ];
  for (const [overrides, pattern] of cases) {
    const calls = [];
    const provider = createAwsCpuProvider({ aws: fakeAws({ overrides, calls }), subnetId, now: () => new Date("2026-09-26T12:10:00Z") });
    await assert.rejects(provider.allocate(job(), { authorizedKeys: [ed25519PublicKey()] }), pattern);
    assert.ok(!calls.some((call) => call.key === "ec2:run-instances"));
  }
});

test("SSH ingress is one tagged /32 rule per job, reused on retry", async () => {
  const calls = [];
  const rules = [];
  const provider = createAwsCpuProvider({ aws: fakeAws({ rules, calls }), subnetId });
  const first = await provider.authorizeSsh(job(), "203.0.113.7/32");
  const second = await provider.authorizeSsh(job(), "203.0.113.7/32");
  assert.deepEqual(first, second);
  assert.equal(calls.filter((call) => call.key === "ec2:authorize-security-group-ingress").length, 1);
  const request = JSON.parse(calls.find((call) => call.key === "ec2:authorize-security-group-ingress").args.at(-1));
  assert.deepEqual(request.IpPermissions[0], { IpProtocol: "tcp", FromPort: 22, ToPort: 22,
    IpRanges: [{ CidrIp: "203.0.113.7/32", Description: `AgentCloud job ${jobId}` }] });
  await assert.rejects(provider.authorizeSsh(job(), "0.0.0.0/0"), /public IPv4 \/32/);
});

test("termination revokes the job's SSH rule before terminating the instance", async () => {
  const calls = [];
  const rules = [{ SecurityGroupRuleId: "sgr-0b0b", IsEgress: false, CidrIpv4: "203.0.113.7/32", Tags: [{ Key: "AgentCloudJobId", Value: jobId }] }];
  const managedTags = [{ Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" }, { Key: "AgentCloudJobId", Value: jobId }];
  let terminated = false;
  const aws = fakeAws({ rules, calls, overrides: {
    "ec2:describe-instances": () => ({ Reservations: [{ Instances: [{ InstanceId: instanceId, Tags: managedTags,
      State: { Name: terminated ? "terminated" : "running" }, BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-0abc" } }] }] }] }),
    "ec2:terminate-instances": () => { terminated = true; return {}; },
    "ec2:describe-volumes": () => { throw new Error("AWS ec2:describe-volumes InvalidVolume.NotFound"); },
  } });
  const provider = createAwsCpuProvider({ aws, subnetId, sleep: async () => {} });
  const result = await provider.terminateInstance(instanceId);
  assert.equal(result.state, "terminated");
  assert.equal(rules.length, 0);
  const order = calls.map((call) => call.key);
  assert.ok(order.indexOf("ec2:revoke-security-group-ingress") < order.indexOf("ec2:terminate-instances"));
});

test("an undeliverable SSM host-key readback is retried as pending; a script failure still fails", async () => {
  const instance = "i-041c189f035f5374b";
  const withInvocation = (invocation) => fakeAws({ overrides: {
    "ssm:describe-instance-information": { InstanceInformationList: [{ InstanceId: instance, PingStatus: "Online" }] },
    "ssm:send-command": { Command: { CommandId: "369e57cb-788c-412b-9169-aad541a97d31" } },
    "ssm:get-command-invocation": invocation,
  } });
  // Live failure on 2026-09-27: the agent reported Online, then the command came back
  // Failed/Undeliverable about 30 s after launch while bootstrap was still running.
  const undeliverable = createAwsCpuProvider({ aws: withInvocation({ Status: "Failed", StatusDetails: "Undeliverable", ResponseCode: -1 }),
    subnetId, sleep: async () => {} });
  assert.deepEqual(await undeliverable.readHostKey(instance), { state: "pending", step: "ssm-delivery" });
  const timedOut = createAwsCpuProvider({ aws: withInvocation({ Status: "TimedOut", StatusDetails: "DeliveryTimedOut", ResponseCode: -1 }),
    subnetId, sleep: async () => {} });
  assert.deepEqual(await timedOut.readHostKey(instance), { state: "pending", step: "ssm-delivery" });
  const scriptFailed = createAwsCpuProvider({ aws: withInvocation({ Status: "Failed", StatusDetails: "Failed", ResponseCode: 1 }),
    subnetId, sleep: async () => {} });
  await assert.rejects(scriptFailed.readHostKey(instance), /Host key readback failed/);
});

test("HAC-166: worker and requester /32 rules share the job tag; revokeSshForJob removes both and nothing else", async () => {
  const calls = [];
  const other = { SecurityGroupRuleId: "sgr-0999", IsEgress: false, CidrIpv4: "198.51.100.9/32",
    Tags: [{ Key: "AgentCloudJobId", Value: "33333333-3333-4333-8333-333333333333" }] };
  const rules = [other];
  let next = 0;
  const aws = fakeAws({ rules, calls, overrides: {
    "ec2:authorize-security-group-ingress": (args) => {
      const input = JSON.parse(args.at(-1));
      const rule = { SecurityGroupRuleId: `sgr-0a${next++}`, IsEgress: false, IpProtocol: "tcp", FromPort: 22, ToPort: 22,
        CidrIpv4: input.IpPermissions[0].IpRanges[0].CidrIp, Tags: input.TagSpecifications[0].Tags };
      rules.push(rule);
      return { Return: true, SecurityGroupRules: [rule] };
    },
  } });
  const provider = createAwsCpuProvider({ aws, subnetId });
  const worker = await provider.authorizeSsh(job(), "184.192.120.7/32");
  const requester = await provider.authorizeSsh(job(), "203.0.113.50/32");
  const again = await provider.authorizeSsh(job(), "184.192.120.7/32");
  assert.notEqual(worker.ruleId, requester.ruleId);
  assert.equal(again.ruleId, worker.ruleId);
  assert.equal(calls.filter((call) => call.key === "ec2:authorize-security-group-ingress").length, 2);
  const revoked = await provider.revokeSshForJob(jobId);
  assert.deepEqual(revoked.sort(), [worker.ruleId, requester.ruleId].sort());
  assert.deepEqual(rules, [other]);
});

test("HAC-166: revokeSshCidr removes one requester rule; termination still revokes every job-tagged rule", async () => {
  const tagged = (id, cidr, job = jobId) => ({ SecurityGroupRuleId: id, IsEgress: false, IpProtocol: "tcp", FromPort: 22, ToPort: 22,
    CidrIpv4: cidr, Tags: [{ Key: "AgentCloudJobId", Value: job }] });
  const other = tagged("sgr-0999", "198.51.100.9/32", "33333333-3333-4333-8333-333333333333");
  const rules = [tagged("sgr-0a01", "184.192.120.7/32"), tagged("sgr-0a02", "203.0.113.50/32"),
    tagged("sgr-0a03", "203.0.113.51/32"), tagged("sgr-0a04", "203.0.113.52/32"), other];
  const managedTags = [{ Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" }, { Key: "AgentCloudJobId", Value: jobId }];
  let terminated = false;
  const aws = fakeAws({ rules, overrides: {
    "ec2:describe-instances": () => ({ Reservations: [{ Instances: [{ InstanceId: instanceId, Tags: managedTags,
      State: { Name: terminated ? "terminated" : "running" }, BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-0abc" } }] }] }] }),
    "ec2:terminate-instances": () => { terminated = true; return {}; },
    "ec2:describe-volumes": () => { throw new Error("AWS ec2:describe-volumes InvalidVolume.NotFound"); },
  } });
  const provider = createAwsCpuProvider({ aws, subnetId, sleep: async () => {} });
  assert.deepEqual(await provider.revokeSshCidr(job(), "203.0.113.50/32"), ["sgr-0a02"]);
  assert.deepEqual(await provider.revokeSshCidr(job(), "203.0.113.99/32"), []);
  assert.equal((await provider.terminateInstance(instanceId)).state, "terminated");
  assert.deepEqual(rules, [other]);
});
