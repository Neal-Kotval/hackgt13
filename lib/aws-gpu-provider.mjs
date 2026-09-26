import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACCOUNT = "662660921850";
const REGION = "us-east-1";
const ROLE = "agentcloud-demo-worker";
const PRICE_CEILING_USD = 1;
const TEMPLATE_NAME = "agentcloud-demo-g6";

export function createAwsCli({ run = execFileAsync, env = process.env } = {}) {
  return async (...args) => {
    const { stdout } = await run("aws", [...args, "--output", "json"], {
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...env, AWS_DEFAULT_REGION: REGION },
    });
    return JSON.parse(stdout);
  };
}

export async function assumeGpuWorkerRole({ aws = createAwsCli(), run = execFileAsync, sessionName = `agentcloud-worker-${process.pid}` } = {}) {
  const source = await aws("sts", "get-caller-identity");
  requireValue(source.Account === ACCOUNT &&
    new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/agentcloud-auth-staging/[^/]+$`).test(source.Arn || ""),
    "GPU worker must start from the private staging instance role; root credentials are rejected");
  const role = await aws("sts", "assume-role", "--role-arn", `arn:aws:iam::${ACCOUNT}:role/${ROLE}`,
    "--role-session-name", sessionName, "--duration-seconds", "3600");
  const credentials = role.Credentials;
  requireValue(credentials?.AccessKeyId && credentials.SecretAccessKey && credentials.SessionToken,
    "Scoped worker role did not return session credentials");
  return createAwsCli({ run, env: {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.SecretAccessKey,
    AWS_SESSION_TOKEN: credentials.SessionToken,
  } });
}

function tags(items = []) {
  return Object.fromEntries(items.map(({ Key, Value }) => [Key, Value]));
}

function instances(response) {
  return (response.Reservations || []).flatMap((reservation) => reservation.Instances || []);
}

function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

function deadlineFor(job, now) {
  requireValue([60, 120].includes(job.max_duration_minutes), "Invalid approved duration");
  const start = new Date(now);
  requireValue(Number.isFinite(start.getTime()), "Invalid clock");
  return { createdAt: start.toISOString(), expiresAt: new Date(start.getTime() + job.max_duration_minutes * 60_000).toISOString() };
}

export function createAwsGpuProvider({ aws = createAwsCli(), subnetId, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  requireValue(/^subnet-[0-9a-f]+$/.test(subnetId || ""), "A GPU subnet ID is required");

  async function identifyWorker() {
    const identity = await aws("sts", "get-caller-identity");
    requireValue(identity.Account === ACCOUNT && new RegExp(`^arn:aws:sts::${ACCOUNT}:assumed-role/${ROLE}/[^/]+$`).test(identity.Arn || ""),
      "GPU worker requires the scoped assumed role; root and application credentials are rejected");
    return identity.Arn;
  }

  async function find(jobId) {
    const result = await aws("ec2", "describe-instances", "--region", REGION, "--filters",
      "Name=tag:Project,Values=AgentCloudDemo", "Name=tag:AgentCloudJobId,Values=" + jobId,
      "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down");
    const found = instances(result);
    requireValue(found.length <= 1, "Multiple EC2 instances have the same job ID; operator reconciliation required");
    return found[0] || null;
  }

  async function listManagedInstances() {
    await identifyWorker();
    const result = await aws("ec2", "describe-instances", "--region", REGION, "--filters",
      "Name=tag:Project,Values=AgentCloudDemo", "Name=tag:AgentCloudAutoExpire,Values=true");
    return instances(result);
  }

  async function inspectInstance(instanceId) {
    await identifyWorker();
    requireValue(/^i-[0-9a-f]+$/.test(instanceId), "Invalid EC2 instance ID");
    let result;
    try {
      result = await aws("ec2", "describe-instances", "--region", REGION, "--instance-ids", instanceId);
    } catch (error) {
      if (String(error.message).includes("InvalidInstanceID.NotFound")) return null;
      throw error;
    }
    const instance = instances(result)[0] || null;
    if (!instance) return null;
    const t = tags(instance.Tags);
    requireValue(t.Project === "AgentCloudDemo" && t.AgentCloudAutoExpire === "true",
      "Refusing to inspect unowned instance");
    return { ...instance, volumeIds: (instance.BlockDeviceMappings || []).map((mapping) => mapping.Ebs?.VolumeId).filter(Boolean) };
  }

  async function inspectVolumes(volumeIds) {
    await identifyWorker();
    requireValue(Array.isArray(volumeIds) && volumeIds.every((id) => /^vol-[0-9a-f]+$/.test(id)), "Invalid volume IDs");
    const results = [];
    for (const id of volumeIds) {
      try {
        const response = await aws("ec2", "describe-volumes", "--region", REGION, "--volume-ids", id);
        const volume = response.Volumes?.[0];
        results.push({ id, state: volume?.State || "unknown" });
      } catch (error) {
        if (String(error.message).includes("InvalidVolume.NotFound")) results.push({ id, state: "deleted" });
        else throw error;
      }
    }
    return results;
  }

  async function preflight() {
    await identifyWorker();
    const [quota, templateResponse, plan, pricing, budget, expiry, rule, targets, subnet, offerings, existing] = await Promise.all([
      aws("service-quotas", "get-service-quota", "--region", REGION, "--service-code", "ec2", "--quota-code", "L-DB2E81BA"),
      aws("ec2", "describe-launch-templates", "--region", REGION, "--launch-template-names", TEMPLATE_NAME),
      aws("freetier", "get-account-plan-state", "--region", REGION),
      aws("pricing", "get-products", "--region", REGION, "--service-code", "AmazonEC2", "--filters",
        "Type=TERM_MATCH,Field=instanceType,Value=g6.xlarge", "Type=TERM_MATCH,Field=location,Value=US East (N. Virginia)",
        "Type=TERM_MATCH,Field=operatingSystem,Value=Linux", "Type=TERM_MATCH,Field=tenancy,Value=Shared",
        "Type=TERM_MATCH,Field=preInstalledSw,Value=NA", "Type=TERM_MATCH,Field=capacitystatus,Value=Used", "--max-results", "1"),
      aws("budgets", "describe-budget", "--region", REGION, "--account-id", ACCOUNT, "--budget-name", "AgentCloud-Demo-Gross-25"),
      aws("lambda", "get-function-configuration", "--region", REGION, "--function-name", "agentcloud-demo-expiry"),
      aws("events", "describe-rule", "--region", REGION, "--name", "agentcloud-demo-expiry"),
      aws("events", "list-targets-by-rule", "--region", REGION, "--rule", "agentcloud-demo-expiry"),
      aws("ec2", "describe-subnets", "--region", REGION, "--subnet-ids", subnetId),
      aws("ec2", "describe-instance-type-offerings", "--region", REGION, "--location-type", "availability-zone", "--filters", "Name=instance-type,Values=g6.xlarge"),
      aws("ec2", "describe-instances", "--region", REGION, "--filters", "Name=tag:Project,Values=AgentCloudDemo", "Name=instance-state-name,Values=pending,running,stopping,stopped"),
    ]);
    requireValue(quota.Quota?.Value >= 4, "G/VT quota below 4 vCPU");
    const template = templateResponse.LaunchTemplates?.[0];
    requireValue(template?.LaunchTemplateId, "GPU launch template missing");
    const version = await aws("ec2", "describe-launch-template-versions", "--region", REGION,
      "--launch-template-id", template.LaunchTemplateId, "--versions", "$Default");
    const data = version.LaunchTemplateVersions?.[0]?.LaunchTemplateData;
    requireValue(data?.InstanceType === "g6.xlarge" && data.MetadataOptions?.HttpTokens === "required", "GPU template profile or IMDSv2 mismatch");
    requireValue(data.IamInstanceProfile?.Arn === `arn:aws:iam::${ACCOUNT}:instance-profile/agentcloud-demo-instance`, "GPU template instance profile mismatch");
    requireValue(data.BlockDeviceMappings?.[0]?.Ebs?.Encrypted === true && data.BlockDeviceMappings?.[0]?.Ebs?.DeleteOnTermination === true,
      "GPU template root volume must be encrypted and disposable");
    const image = await aws("ec2", "describe-images", "--region", REGION, "--image-ids", data.ImageId);
    requireValue(image.Images?.[0]?.State === "available" && image.Images[0].Architecture === "x86_64" &&
      image.Images[0].RootDeviceName === data.BlockDeviceMappings[0].DeviceName, "GPU AMI unavailable or root device mismatch");
    const groups = await aws("ec2", "describe-security-groups", "--region", REGION, "--group-ids", ...data.SecurityGroupIds);
    requireValue(groups.SecurityGroups?.length > 0 && groups.SecurityGroups.every((group) => group.IpPermissions.length === 0), "GPU security group has inbound access");
    const templateTags = tags(data.TagSpecifications?.find((entry) => entry.ResourceType === "instance")?.Tags);
    requireValue(templateTags.Project === "AgentCloudDemo" && templateTags.AgentCloudAutoExpire === "true", "GPU template expiry tags missing");
    const volumeTags = tags(data.TagSpecifications?.find((entry) => entry.ResourceType === "volume")?.Tags);
    requireValue(volumeTags.Project === "AgentCloudDemo" && volumeTags.AgentCloudAutoExpire === "true", "GPU template volume tags missing");
    const s = subnet.Subnets?.[0];
    requireValue(s?.SubnetId === subnetId && s.State === "available" && s.MapPublicIpOnLaunch === true,
      "Selected subnet is unavailable or lacks public IP egress for SSM");
    requireValue(offerings.InstanceTypeOfferings?.some((item) => item.Location === s.AvailabilityZone), "G6 is not offered in selected zone");
    requireValue(plan.accountId === ACCOUNT && plan.accountPlanType === "FREE" && plan.accountPlanStatus === "ACTIVE" &&
      plan.accountPlanRemainingCredits?.unit === "USD" && plan.accountPlanRemainingCredits.amount > 0 &&
      Date.parse(plan.accountPlanExpirationDate) > now().getTime() + 3 * 60 * 60 * 1000, "Free plan credits or runtime window unavailable");
    const product = JSON.parse(pricing.PriceList?.[0] || "{}");
    const term = Object.values(product.terms?.OnDemand || {})[0];
    const price = Number(Object.values(term?.priceDimensions || {}).find((dimension) => dimension.unit === "Hrs")?.pricePerUnit?.USD);
    requireValue(price > 0 && price <= PRICE_CEILING_USD, "G6 compute price exceeds $1/hour ceiling");
    requireValue(Number(budget.Budget?.BudgetLimit?.Amount) === 25 && budget.Budget.BudgetLimit.Unit === "USD", "Gross $25 warning budget missing");
    requireValue(expiry.State === "Active" && expiry.LastUpdateStatus === "Successful" && expiry.Environment?.Variables?.MAX_AGE_MINUTES === "120" &&
      rule.State === "ENABLED" && rule.ScheduleExpression === "rate(5 minutes)" && targets.Targets?.some((target) => target.Arn === expiry.FunctionArn),
      "Automated expiry guard unavailable");
    requireValue(instances(existing).length === 0, "Another demo instance is active; reconcile it before launching");
    return { launchTemplateId: template.LaunchTemplateId, subnetId, availabilityZone: s.AvailabilityZone, hourlyComputeUsd: price };
  }

  async function allocate(job) {
    requireValue(job?.provider === "aws-ec2" && /^[a-f0-9-]{36}$/.test(job.id || ""), "Invalid approved EC2 job");
    await identifyWorker();
    const prior = await find(job.id);
    if (prior) return prior;
    const checked = await preflight();
    const { createdAt, expiresAt } = deadlineFor(job, now());
    const instanceTags = [
      { Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" },
      { Key: "AgentCloudJobId", Value: job.id }, { Key: "AgentCloudProjectId", Value: job.project_id },
      { Key: "AgentCloudCreatedAt", Value: createdAt }, { Key: "AgentCloudExpiresAt", Value: expiresAt },
    ];
    const result = await aws("ec2", "run-instances", "--region", REGION, "--cli-input-json", JSON.stringify({
      ClientToken: job.id,
      MinCount: 1, MaxCount: 1,
      LaunchTemplate: { LaunchTemplateId: checked.launchTemplateId, Version: "$Default" },
      SubnetId: checked.subnetId,
      TagSpecifications: [{ ResourceType: "instance", Tags: instanceTags }],
    }));
    const instance = result.Instances?.[0];
    requireValue(instance?.InstanceId && tags(instance.Tags).AgentCloudJobId === job.id, "EC2 allocation response lacked the approved job tag");
    return instance;
  }

  async function inspect(job) {
    await identifyWorker();
    const instance = await find(job.id);
    if (!instance) return null;
    requireValue(!job.provider_resource_id || instance.InstanceId === job.provider_resource_id, "Provider instance ID does not match job tag");
    return instance;
  }

  async function verify(instanceId, jobId) {
    await identifyWorker();
    requireValue(/^i-[0-9a-f]+$/.test(instanceId), "Invalid EC2 instance ID");
    requireValue(/^[a-f0-9-]{36}$/.test(jobId), "Invalid run-box job ID");
    let online = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      const managed = await aws("ssm", "describe-instance-information", "--region", REGION,
        "--filters", `Key=InstanceIds,Values=${instanceId}`);
      online = managed.InstanceInformationList?.some((item) => item.InstanceId === instanceId && item.PingStatus === "Online");
      if (online) break;
      await sleep(4_000);
    }
    requireValue(online, "GPU instance did not become online in Systems Manager");
    const workspace = `/home/ec2-user/agentcloud/${jobId}`;
    const commands = [
      "set -euo pipefail",
      `install -d -o ec2-user -g ec2-user -m 0700 ${workspace}`,
      `sudo -u ec2-user test -w ${workspace}`,
      "sudo -u ec2-user bash -lc 'test \"$(id -u)\" != 0 && nvidia-smi -L'",
      "sudo -u ec2-user python3 -c 'import torch; assert torch.cuda.is_available(); x=torch.ones(4,device=\"cuda\"); print(\"AGENTCLOUD_CUDA_OK\",int(x.sum().item()))'",
      "echo AGENTCLOUD_WORKSPACE_OK",
    ];
    const sent = await aws("ssm", "send-command", "--region", REGION, "--cli-input-json", JSON.stringify({
      InstanceIds: [instanceId], DocumentName: "AWS-RunShellScript", TimeoutSeconds: 180,
      Parameters: { commands },
    }));
    const commandId = sent.Command?.CommandId;
    requireValue(commandId, "SSM did not return a command ID");
    let invocation;
    for (let attempt = 0; attempt < 95; attempt++) {
      await sleep(2_000);
      try {
        invocation = await aws("ssm", "get-command-invocation", "--region", REGION, "--command-id", commandId, "--instance-id", instanceId);
      } catch (error) {
        if (String(error.message).includes("InvocationDoesNotExist")) continue;
        throw error;
      }
      if (["Success", "Failed", "Cancelled", "TimedOut", "Cancelling"].includes(invocation.Status)) break;
    }
    requireValue(invocation?.Status === "Success" && invocation.ResponseCode === 0 &&
      invocation.StandardOutputContent?.includes("AGENTCLOUD_CUDA_OK 4") &&
      invocation.StandardOutputContent?.includes("AGENTCLOUD_WORKSPACE_OK"), `GPU verification failed (SSM ${commandId}, ${invocation?.Status || "timeout"})`);
    return { instanceId, workspace, remoteAccount: "ec2-user", evidenceRef: `ssm:${commandId}` };
  }

  async function terminate(job) {
    await identifyWorker();
    const instance = await find(job.id);
    if (!instance) {
      requireValue(!job.provider_resource_id && job.attempts === 0,
        "EC2 allocation may have been attempted; absence does not prove EBS cleanup");
      return { evidenceRef: `ec2:absent:${job.id}`, instanceId: null, state: "absent" };
    }
    requireValue(!job.provider_resource_id || instance.InstanceId === job.provider_resource_id, "Stop target differs from recorded instance");
    return terminateInstance(instance.InstanceId);
  }

  async function terminateInstance(id) {
    const instance = await inspectInstance(id);
    requireValue(instance, "Managed EC2 instance missing; cannot confirm volume cleanup");
    const volumeIds = instance.volumeIds;
    if (!["shutting-down", "terminated"].includes(instance.State?.Name)) {
      await aws("ec2", "terminate-instances", "--region", REGION, "--instance-ids", id);
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      await sleep(3_000);
      const observed = await aws("ec2", "describe-instances", "--region", REGION, "--instance-ids", id);
      const current = instances(observed)[0];
      if (current?.State?.Name === "terminated") {
        const volumes = await inspectVolumes(volumeIds);
        if (volumes.every((volume) => volume.state === "deleted"))
          return { evidenceRef: `ec2:terminated:${id}`, instanceId: id, state: "terminated", volumeIds };
      }
    }
    throw new Error(`EC2 termination not confirmed for ${id}`);
  }

  return { identifyWorker, preflight, find, listManagedInstances, inspectInstance, inspectVolumes, allocate, inspect, verify, terminate, terminateInstance };
}
