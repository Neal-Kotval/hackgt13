#!/usr/bin/env node

// Read-only checks for the existing AgentCloud GPU demo foundation.
// Passing these checks is not permission to launch an instance.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const region = "us-east-1";
const accountId = "662660921850";
const checks = [];

async function aws(...args) {
  const { stdout } = await execFileAsync("aws", [...args, "--output", "json"], {
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function check(label, passed, detail) {
  checks.push({ label, passed, detail });
}

function tags(items) {
  return Object.fromEntries((items || []).map(({ Key, Value }) => [Key, Value]));
}

try {
  const identity = await aws("sts", "get-caller-identity");
  check("AWS account", identity.Account === accountId, identity.Account);
  if (identity.Account !== accountId) throw Error("Account mismatch; stopped before regional checks");

  const [quota, templates, budget, expiry, rule, instances] = await Promise.all([
    aws("service-quotas", "get-service-quota", "--region", region, "--service-code", "ec2", "--quota-code", "L-DB2E81BA"),
    aws("ec2", "describe-launch-templates", "--region", region, "--launch-template-names", "agentcloud-demo-g6"),
    aws("budgets", "describe-budget", "--account-id", accountId, "--budget-name", "AgentCloud-Demo-Gross-25"),
    aws("lambda", "get-function-configuration", "--region", region, "--function-name", "agentcloud-demo-expiry"),
    aws("events", "describe-rule", "--region", region, "--name", "agentcloud-demo-expiry"),
    aws("ec2", "describe-instances", "--region", region, "--filters", "Name=tag:Project,Values=AgentCloudDemo", "Name=instance-state-name,Values=pending,running,stopping,stopped"),
  ]);

  const vcpus = quota.Quota?.Value;
  check("On-Demand G/VT quota", vcpus >= 4, `${vcpus} vCPU in ${region}`);

  const template = templates.LaunchTemplates?.[0];
  const versions = await aws("ec2", "describe-launch-template-versions", "--region", region, "--launch-template-id", template.LaunchTemplateId, "--versions", "$Default");
  const data = versions.LaunchTemplateVersions?.[0]?.LaunchTemplateData;
  check("GPU launch profile", data?.InstanceType === "g6.xlarge", data?.InstanceType || "missing");
  check("IMDSv2 required", data?.MetadataOptions?.HttpTokens === "required", data?.MetadataOptions?.HttpTokens || "missing");
  const disk = data?.BlockDeviceMappings?.[0]?.Ebs;
  check("Encrypted disposable root disk", disk?.Encrypted === true && disk?.DeleteOnTermination === true, JSON.stringify({ encrypted: disk?.Encrypted, deleteOnTermination: disk?.DeleteOnTermination }));
  const instanceTags = tags(data?.TagSpecifications?.find((item) => item.ResourceType === "instance")?.Tags);
  check("Expiry tags in template", instanceTags.Project === "AgentCloudDemo" && instanceTags.AgentCloudAutoExpire === "true", JSON.stringify(instanceTags));

  const [images, groups] = await Promise.all([
    aws("ec2", "describe-images", "--region", region, "--image-ids", data.ImageId),
    aws("ec2", "describe-security-groups", "--region", region, "--group-ids", ...data.SecurityGroupIds),
  ]);
  const image = images.Images?.[0];
  check("GPU AMI", image?.State === "available" && image?.Architecture === "x86_64" && image?.RootDeviceName === data.BlockDeviceMappings?.[0]?.DeviceName, `${data.ImageId}: ${image?.State || "missing"}`);
  check("No inbound security rules", groups.SecurityGroups?.length > 0 && groups.SecurityGroups.every((group) => group.IpPermissions.length === 0), `${groups.SecurityGroups?.length || 0} group(s)`);

  check("Expiry Lambda", expiry.State === "Active" && expiry.LastUpdateStatus === "Successful" && expiry.Environment?.Variables?.MAX_AGE_MINUTES === "120", `${expiry.State}, max age ${expiry.Environment?.Variables?.MAX_AGE_MINUTES} minutes`);
  check("Expiry schedule", rule.State === "ENABLED" && rule.ScheduleExpression === "rate(5 minutes)", `${rule.State}, ${rule.ScheduleExpression}`);
  const active = (instances.Reservations || []).flatMap((reservation) => reservation.Instances || []);
  check("No active demo instance", active.length === 0, `${active.length} active instance(s)`);

  const limit = Number(budget.Budget?.BudgetLimit?.Amount);
  check("Gross monthly warning budget", limit === 25 && budget.Budget?.BudgetLimit?.Unit === "USD", `${limit} USD; alerts do not stop compute`);
} catch (error) {
  console.error(`Preflight could not finish: ${error.message}`);
  process.exitCode = 1;
}

for (const item of checks) console.log(`${item.passed ? "PASS" : "FAIL"} ${item.label}: ${item.detail}`);
if (checks.some((item) => !item.passed)) process.exitCode = 1;
console.log("Launch still requires current credit/price/capacity checks, an approved worker job, scoped worker role, and verified cleanup.");
