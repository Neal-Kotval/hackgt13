import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { createAwsCli, createAwsGpuProvider } from "./aws-gpu-provider.mjs";
import { normalizePublicKey } from "./ssh-keys.mjs";

// AWS CPU environment (HAC-125, profile `aws-cpu`). One t3.medium from the Terraform
// template `agentcloud-demo-cpu`, reached by the desktop app over direct SSH:
// public IPv4 + a per-job tcp/22 rule from the requester's /32 + a host key that is
// generated on the box and read back through Systems Manager (never through user data).
// Generic tagged-instance operations (inventory, termination, EBS proof) are reused
// from the EC2 GPU adapter so the existing reconciler applies unchanged.

const ACCOUNT = "662660921850";
const REGION = "us-east-1";
export const CPU_TEMPLATE_NAME = "agentcloud-demo-cpu";
export const CPU_SSH_GROUP_NAME = "agentcloud-demo-cpu-ssh";
export const CPU_INSTANCE_TYPE = "t3.medium";
export const CPU_PRICE_CEILING_USD = 0.1;
export const CPU_SSH_USER = "agentcloud";
export const CODEX_VERSION = "0.157.1";
export const NODE_VERSION = "22.23.3";
// sha256 of node-v22.23.3-linux-x64.tar.xz from https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
export const NODE_SHA256 = "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de";
export const BOOTSTRAP_LOG = "/var/log/agentcloud-bootstrap.log";
export const BOOTSTRAP_DIR = "/var/lib/agentcloud";
const MAX_OUTPUT = 64 * 1024;
const execFileAsync = promisify(execFile);

function requireValue(ok, message) { if (!ok) throw new Error(message); }
function tags(items = []) { return Object.fromEntries(items.map(({ Key, Value }) => [Key, Value])); }
function instances(response) { return (response.Reservations || []).flatMap((reservation) => reservation.Instances || []); }
const JOB_ID = /^[a-f0-9-]{36}$/;

export function cpuWorkspace(jobId) {
  requireValue(JOB_ID.test(jobId || ""), "Invalid run-box job ID");
  return `/home/${CPU_SSH_USER}/agentcloud/${jobId}/repo`;
}

function privateOrReservedIpv4(ip) {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// Only a single public IPv4 host may reach port 22.
export function validateSshSourceCidr(value) {
  requireValue(typeof value === "string", "SSH source must be a public IPv4 /32");
  const [ip, prefix] = value.trim().split("/");
  requireValue(prefix === "32" && isIP(ip) === 4 && !privateOrReservedIpv4(ip), "SSH source must be a public IPv4 /32");
  return `${ip}/32`;
}

// The requester's current public address. Locally the worker and the desktop app share
// an egress address, so this is discovered at allocation time on the requester's machine.
export async function discoverPublicIpv4({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl("https://checkip.amazonaws.com/", { signal: AbortSignal.timeout(10_000) });
  requireValue(response.ok, "Public IPv4 discovery failed");
  return validateSshSourceCidr(`${String(await response.text()).trim()}/32`);
}

function lifetimeMinutes(job, now, capMinutes) {
  requireValue([60, 120].includes(job.max_duration_minutes) && Number.isFinite(Date.parse(job.created_at)), "Invalid approved duration");
  const deadline = Date.parse(job.created_at) + job.max_duration_minutes * 60_000;
  const remaining = Math.floor((deadline - now.getTime()) / 60_000);
  const minutes = Math.min(remaining, capMinutes ?? 120, 120);
  requireValue(minutes >= 5, "Approved deadline leaves no time for a CPU environment");
  return minutes;
}

// Cloud-init user data. It holds only public data (device/operator public keys, pinned
// versions, checksums), because user data is readable by any on-box process through
// IMDS and by account principals with ec2:DescribeInstanceAttribute. The host key is
// generated here, on the box, and its private half never leaves the instance.
export function buildCpuUserData({ jobId, authorizedKeys, lifetimeMinutes: minutes }) {
  requireValue(JOB_ID.test(jobId || ""), "Invalid run-box job ID");
  requireValue(Number.isInteger(minutes) && minutes >= 5 && minutes <= 120, "Invalid self-destruct timer");
  requireValue(Array.isArray(authorizedKeys) && authorizedKeys.length > 0 && authorizedKeys.length <= 64,
    "At least one authorized public key is required");
  const keys = [...new Set(authorizedKeys.map((key) => normalizePublicKey(key)))];
  const keysB64 = Buffer.from(keys.map((key) => `${key}\n`).join("")).toString("base64");
  const home = `/home/${CPU_SSH_USER}`;
  return `#!/bin/bash
# AgentCloud aws-cpu bootstrap for job ${jobId}. Public data only.
set -euo pipefail
umask 022
install -d -m 755 ${BOOTSTRAP_DIR}
touch ${BOOTSTRAP_LOG} && chmod 644 ${BOOTSTRAP_LOG}
exec >>${BOOTSTRAP_LOG} 2>&1
step() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; printf '%s\\n' "$1" > ${BOOTSTRAP_DIR}/bootstrap.step; }
trap 'printf "%s\\n" "$(cat ${BOOTSTRAP_DIR}/bootstrap.step 2>/dev/null || echo unknown)" > ${BOOTSTRAP_DIR}/bootstrap.failed' ERR
step self-destruct
# Launch template sets instance-initiated shutdown to terminate; EBS is deleted on termination.
shutdown -P +${minutes} "AgentCloud environment deadline"
step sshd
rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub
ssh-keygen -q -t ed25519 -N '' -C '' -f /etc/ssh/ssh_host_ed25519_key
cat > /etc/ssh/sshd_config.d/00-agentcloud.conf <<'CONF'
HostKey /etc/ssh/ssh_host_ed25519_key
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AuthenticationMethods publickey
AuthorizedKeysCommand none
AllowUsers ${CPU_SSH_USER}
CONF
chmod 644 /etc/ssh/sshd_config.d/00-agentcloud.conf
sshd -t
step account
id ${CPU_SSH_USER} >/dev/null 2>&1 || useradd -m -s /bin/bash ${CPU_SSH_USER}
install -d -m 700 -o ${CPU_SSH_USER} -g ${CPU_SSH_USER} ${home}/.ssh
printf '%s' '${keysB64}' | base64 -d > ${home}/.ssh/authorized_keys
chmod 600 ${home}/.ssh/authorized_keys
chown ${CPU_SSH_USER}:${CPU_SSH_USER} ${home}/.ssh/authorized_keys
systemctl restart sshd
step packages
dnf install -y -q --setopt=install_weak_deps=False git tmux tar xz
step node
curl -fsSL --retry 3 -o /tmp/node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz
printf '%s  /tmp/node.tar.xz\\n' '${NODE_SHA256}' | sha256sum -c -
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner
rm -f /tmp/node.tar.xz
/usr/local/bin/node --version
step codex
/usr/local/bin/npm install -g --no-fund --no-audit --loglevel=error @openai/codex@${CODEX_VERSION}
/usr/local/bin/codex --version | grep -F '${CODEX_VERSION}'
# Sign-in lands in ~/.codex/auth.json (not a keyring) so teardown can remove it.
install -d -m 700 -o ${CPU_SSH_USER} -g ${CPU_SSH_USER} ${home}/.codex
printf 'cli_auth_credentials_store = "file"\\n' > ${home}/.codex/config.toml
chown ${CPU_SSH_USER}:${CPU_SSH_USER} ${home}/.codex/config.toml
chmod 600 ${home}/.codex/config.toml
step workspace
install -d -m 700 -o ${CPU_SSH_USER} -g ${CPU_SSH_USER} ${home}/agentcloud ${home}/agentcloud/${jobId}
step done
date -u +%Y-%m-%dT%H:%M:%SZ > ${BOOTSTRAP_DIR}/bootstrap.done
`;
}

// Read over SSM (authenticated AWS channel to this instance's agent), so the pinned host
// key is not trust-on-first-use. It also proves sshd itself serves that key.
export const HOST_KEY_READBACK = `set -u
if [ -f ${BOOTSTRAP_DIR}/bootstrap.failed ]; then echo "AGENTCLOUD_BOOTSTRAP=failed:$(head -c 32 ${BOOTSTRAP_DIR}/bootstrap.failed | tr -cd 'a-z-')"; exit 0; fi
if [ ! -f ${BOOTSTRAP_DIR}/bootstrap.done ]; then echo "AGENTCLOUD_BOOTSTRAP=pending:$(head -c 32 ${BOOTSTRAP_DIR}/bootstrap.step 2>/dev/null | tr -cd 'a-z-')"; exit 0; fi
echo "AGENTCLOUD_BOOTSTRAP=done"
echo "AGENTCLOUD_HOSTKEY=$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
echo "AGENTCLOUD_SCANNED=$(ssh-keyscan -T 5 -t ed25519 127.0.0.1 2>/dev/null | awk '$2 == "ssh-ed25519" {print $2" "$3; exit}')"
`;

export function parseHostKeyReadback(stdout) {
  const lines = Object.fromEntries(String(stdout).split("\n").filter((line) => line.startsWith("AGENTCLOUD_"))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]));
  const bootstrap = lines.AGENTCLOUD_BOOTSTRAP || "";
  if (bootstrap.startsWith("failed:")) return { state: "failed", step: bootstrap.slice(7) || "unknown" };
  if (bootstrap !== "done") return { state: "pending", step: bootstrap.startsWith("pending:") ? bootstrap.slice(8) || "boot" : "boot" };
  const hostPublicKey = normalizePublicKey(lines.AGENTCLOUD_HOSTKEY || "");
  requireValue(normalizePublicKey(lines.AGENTCLOUD_SCANNED || "") === hostPublicKey,
    "sshd does not serve the generated host key");
  return { state: "ready", hostPublicKey };
}

function shellValue(value) {
  return `$(printf '%s' '${Buffer.from(value || "").toString("base64")}' | base64 -d)`;
}

// Runs as `agentcloud` over the pinned SSH path after the bootstrap marker exists.
export function agentCheckScript(job) {
  const workspace = cpuWorkspace(job.id);
  return `set -euo pipefail
[ -f ${BOOTSTRAP_DIR}/bootstrap.done ]
[ "$(id -un)" = "${CPU_SSH_USER}" ]
[ "$(id -u)" -ne 0 ]
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
repo="${workspace}"
url="${shellValue(job.repo_url)}"
revision="${shellValue(job.repo_revision)}"
if [ ! -d "$repo/.git" ]; then
  rm -rf "$repo.incoming"
  git -c credential.helper= -c protocol.file.allow=never clone --quiet -- "$url" "$repo.incoming"
  mv "$repo.incoming" "$repo"
fi
[ "$(git -C "$repo" config --get remote.origin.url)" = "$url" ]
if [ -n "$revision" ] && [ "$(git -C "$repo" rev-parse HEAD)" != "$revision" ]; then
  git -C "$repo" fetch --quiet --depth 1 origin "$revision"
  git -C "$repo" checkout --quiet --detach "$revision"
fi
AC_ACCOUNT="$(id -un)" AC_UID="$(id -u)" AC_WORKSPACE="$repo" AC_SHA="$(git -C "$repo" rev-parse HEAD)" \\
AC_CODEX="$(codex --version 2>/dev/null | head -n 1)" AC_TMUX="$(tmux -V)" AC_GIT="$(git --version)" \\
AC_NODE="$(node --version)" node -e 'const e = process.env; console.log("AGENTCLOUD_EVIDENCE=" + JSON.stringify({
  account: e.AC_ACCOUNT, uid: Number(e.AC_UID), workspace: e.AC_WORKSPACE, repo_sha: e.AC_SHA,
  codex: e.AC_CODEX, tmux: e.AC_TMUX, git: e.AC_GIT, node: e.AC_NODE }))'
`;
}

export function parseAgentCheck(stdout, job) {
  const lines = String(stdout).split("\n").filter((line) => line.startsWith("AGENTCLOUD_EVIDENCE="));
  requireValue(lines.length === 1, "CPU environment proof is missing or ambiguous");
  let proof;
  try { proof = JSON.parse(lines[0].slice("AGENTCLOUD_EVIDENCE=".length)); }
  catch { throw new Error("CPU environment proof is invalid"); }
  const short = (value) => typeof value === "string" && value.length > 0 && value.length <= 128;
  requireValue(proof.account === CPU_SSH_USER && Number.isInteger(proof.uid) && proof.uid > 0 &&
    proof.workspace === cpuWorkspace(job.id) && /^[a-f0-9]{40,64}$/.test(proof.repo_sha || "") &&
    (!job.repo_revision || proof.repo_sha === job.repo_revision) &&
    short(proof.codex) && proof.codex.split(/\s+/).includes(CODEX_VERSION) &&
    short(proof.tmux) && /^tmux /.test(proof.tmux) && short(proof.git) && /^git version /.test(proof.git) &&
    short(proof.node) && proof.node.startsWith("v22."), "CPU environment proof is incomplete");
  return { ...proof, outputSha256: createHash("sha256").update(lines[0]).digest("hex") };
}

// OpenSSH client with a pinned known_hosts file and no agent/config fallbacks.
export function runCpuSsh(connection, script, { timeoutMs = 180_000 } = {}) {
  requireValue(isIP(connection?.host || "") === 4 && connection.port === 22, "CPU SSH endpoint must be a public IPv4 on port 22");
  requireValue(typeof connection.keyFile === "string" && connection.keyFile.startsWith("/") &&
    typeof connection.knownHostsFile === "string" && connection.knownHostsFile.startsWith("/"),
  "CPU SSH key and pinned known-hosts file are required");
  const args = ["-F", "/dev/null", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${connection.knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR", "-i", connection.keyFile, "-p", "22",
    `${CPU_SSH_USER}@${connection.host}`, "bash -s"];
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let failed = null;
    const timer = setTimeout(() => { failed = "CPU SSH command timed out"; child.kill("SIGKILL"); }, timeoutMs);
    const collect = (append) => (data) => {
      append(String(data));
      if (stdout.length + stderr.length > MAX_OUTPUT) { failed = "CPU SSH output exceeded limit"; child.kill("SIGKILL"); }
    };
    child.stdin.on("error", () => { /* ssh may exit before reading the script. */ });
    child.stdout.on("data", collect((text) => { stdout += text; }));
    child.stderr.on("data", collect((text) => { stderr += text; }));
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return reject(new Error(failed));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(script);
  });
}

export function createAwsCpuProvider({ aws = createAwsCli(), subnetId, now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), ssh = runCpuSsh } = {}) {
  const base = createAwsGpuProvider({ aws, subnetId, now, sleep });

  async function cpuSshGroup() {
    const result = await aws("ec2", "describe-security-groups", "--region", REGION,
      "--filters", `Name=group-name,Values=${CPU_SSH_GROUP_NAME}`);
    const group = result.SecurityGroups?.[0];
    requireValue(result.SecurityGroups?.length === 1 && /^sg-[0-9a-f]+$/.test(group.GroupId || ""), "CPU SSH security group missing");
    return group;
  }

  async function ingressRules(groupId) {
    const result = await aws("ec2", "describe-security-group-rules", "--region", REGION,
      "--filters", `Name=group-id,Values=${groupId}`);
    return (result.SecurityGroupRules || []).filter((rule) => rule.IsEgress === false);
  }

  async function revokeRules(groupId, rules) {
    const ids = rules.map((rule) => rule.SecurityGroupRuleId);
    requireValue(ids.every((id) => /^sgr-[0-9a-f]+$/.test(id || "")), "Invalid security group rule ID");
    if (ids.length) await aws("ec2", "revoke-security-group-ingress", "--region", REGION,
      "--group-id", groupId, "--security-group-rule-ids", ...ids);
    return ids;
  }

  // Removes every SSH rule except those tagged for `keepJobId`. Safe because at most one
  // AWS box is active and preflight has already required an empty instance inventory.
  async function revokeStaleSshRules(keepJobId = null) {
    await base.identifyWorker();
    const group = await cpuSshGroup();
    const stale = (await ingressRules(group.GroupId)).filter((rule) => !keepJobId || tags(rule.Tags).AgentCloudJobId !== keepJobId);
    return revokeRules(group.GroupId, stale);
  }

  async function revokeSshForJob(jobId) {
    await base.identifyWorker();
    requireValue(JOB_ID.test(jobId || ""), "Invalid run-box job ID");
    const group = await cpuSshGroup();
    return revokeRules(group.GroupId, (await ingressRules(group.GroupId)).filter((rule) => tags(rule.Tags).AgentCloudJobId === jobId));
  }

  async function authorizeSsh(job, sourceCidr) {
    await base.identifyWorker();
    const cidr = validateSshSourceCidr(sourceCidr);
    requireValue(JOB_ID.test(job?.id || ""), "Invalid run-box job ID");
    const group = await cpuSshGroup();
    const rules = await ingressRules(group.GroupId);
    const existing = rules.find((rule) => tags(rule.Tags).AgentCloudJobId === job.id && rule.CidrIpv4 === cidr &&
      rule.IpProtocol === "tcp" && rule.FromPort === 22 && rule.ToPort === 22);
    if (existing) return { groupId: group.GroupId, ruleId: existing.SecurityGroupRuleId, cidr };
    const result = await aws("ec2", "authorize-security-group-ingress", "--region", REGION, "--cli-input-json", JSON.stringify({
      GroupId: group.GroupId,
      IpPermissions: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22,
        IpRanges: [{ CidrIp: cidr, Description: `AgentCloud job ${job.id}` }] }],
      TagSpecifications: [{ ResourceType: "security-group-rule", Tags: [
        { Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudJobId", Value: job.id }] }],
    }));
    const ruleId = result.SecurityGroupRules?.[0]?.SecurityGroupRuleId;
    requireValue(result.Return === true && /^sgr-[0-9a-f]+$/.test(ruleId || ""), "SSH ingress rule was not created");
    return { groupId: group.GroupId, ruleId, cidr };
  }

  // `revokeStale: false` keeps preflight read-only (used by the smoke test's dry run).
  async function preflight(job, { revokeStale = true } = {}) {
    await base.identifyWorker();
    const [templateResponse, plan, pricing, budget, expiry, rule, targets, subnet, offerings, existing] = await Promise.all([
      aws("ec2", "describe-launch-templates", "--region", REGION, "--launch-template-names", CPU_TEMPLATE_NAME),
      aws("freetier", "get-account-plan-state", "--region", REGION),
      aws("pricing", "get-products", "--region", REGION, "--service-code", "AmazonEC2", "--filters",
        `Type=TERM_MATCH,Field=instanceType,Value=${CPU_INSTANCE_TYPE}`, "Type=TERM_MATCH,Field=location,Value=US East (N. Virginia)",
        "Type=TERM_MATCH,Field=operatingSystem,Value=Linux", "Type=TERM_MATCH,Field=tenancy,Value=Shared",
        "Type=TERM_MATCH,Field=preInstalledSw,Value=NA", "Type=TERM_MATCH,Field=capacitystatus,Value=Used", "--max-results", "1"),
      aws("budgets", "describe-budget", "--region", REGION, "--account-id", ACCOUNT, "--budget-name", "AgentCloud-Demo-Gross-25"),
      aws("lambda", "get-function-configuration", "--region", REGION, "--function-name", "agentcloud-demo-expiry"),
      aws("events", "describe-rule", "--region", REGION, "--name", "agentcloud-demo-expiry"),
      aws("events", "list-targets-by-rule", "--region", REGION, "--rule", "agentcloud-demo-expiry"),
      aws("ec2", "describe-subnets", "--region", REGION, "--subnet-ids", subnetId),
      aws("ec2", "describe-instance-type-offerings", "--region", REGION, "--location-type", "availability-zone",
        "--filters", `Name=instance-type,Values=${CPU_INSTANCE_TYPE}`),
      aws("ec2", "describe-instances", "--region", REGION, "--filters", "Name=tag:Project,Values=AgentCloudDemo",
        "Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down"),
    ]);
    requireValue(plan?.accountId === ACCOUNT && plan.accountPlanType === "PAID" && plan.accountPlanStatus === "ACTIVE",
      `${CPU_INSTANCE_TYPE} requires an active AWS Paid plan; current plan is ${plan?.accountPlanType || "unknown"}`);
    const template = templateResponse.LaunchTemplates?.[0];
    requireValue(template?.LaunchTemplateId, "CPU launch template missing");
    const version = await aws("ec2", "describe-launch-template-versions", "--region", REGION,
      "--launch-template-id", template.LaunchTemplateId, "--versions", "$Default");
    const data = version.LaunchTemplateVersions?.[0]?.LaunchTemplateData;
    requireValue(data?.InstanceType === CPU_INSTANCE_TYPE && data.MetadataOptions?.HttpTokens === "required",
      "CPU template profile or IMDSv2 mismatch");
    requireValue(data.InstanceInitiatedShutdownBehavior === "terminate", "CPU template must terminate on instance shutdown");
    requireValue(data.IamInstanceProfile?.Arn === `arn:aws:iam::${ACCOUNT}:instance-profile/agentcloud-demo-instance`,
      "CPU template instance profile mismatch");
    requireValue(data.BlockDeviceMappings?.[0]?.Ebs?.Encrypted === true && data.BlockDeviceMappings[0].Ebs.DeleteOnTermination === true,
      "CPU template root volume must be encrypted and disposable");
    requireValue(!data.UserData, "CPU template must not carry user data");
    const image = await aws("ec2", "describe-images", "--region", REGION, "--image-ids", data.ImageId);
    requireValue(image.Images?.[0]?.State === "available" && image.Images[0].Architecture === "x86_64" &&
      image.Images[0].RootDeviceName === data.BlockDeviceMappings[0].DeviceName, "CPU AMI unavailable or root device mismatch");
    const groups = await aws("ec2", "describe-security-groups", "--region", REGION, "--group-ids", ...(data.SecurityGroupIds || []));
    const sshGroup = groups.SecurityGroups?.find((group) => group.GroupName === CPU_SSH_GROUP_NAME);
    const others = (groups.SecurityGroups || []).filter((group) => group !== sshGroup);
    requireValue(sshGroup && others.length === 1 && others[0].IpPermissions.length === 0,
      "CPU template must use the SSM group (no inbound) and the CPU SSH group");
    const instanceTags = tags(data.TagSpecifications?.find((entry) => entry.ResourceType === "instance")?.Tags);
    const volumeTags = tags(data.TagSpecifications?.find((entry) => entry.ResourceType === "volume")?.Tags);
    requireValue(instanceTags.Project === "AgentCloudDemo" && instanceTags.AgentCloudAutoExpire === "true" &&
      volumeTags.Project === "AgentCloudDemo" && volumeTags.AgentCloudAutoExpire === "true", "CPU template expiry tags missing");
    const s = subnet.Subnets?.[0];
    requireValue(s?.SubnetId === subnetId && s.State === "available" && s.MapPublicIpOnLaunch === true,
      "Selected subnet is unavailable or does not assign public IPv4 addresses");
    requireValue(offerings.InstanceTypeOfferings?.some((item) => item.Location === s.AvailabilityZone),
      `${CPU_INSTANCE_TYPE} is not offered in the selected zone`);
    const product = JSON.parse(pricing.PriceList?.[0] || "{}");
    const term = Object.values(product.terms?.OnDemand || {})[0];
    const price = Number(Object.values(term?.priceDimensions || {}).find((dimension) => dimension.unit === "Hrs")?.pricePerUnit?.USD);
    requireValue(price > 0 && price <= CPU_PRICE_CEILING_USD, `CPU compute price exceeds $${CPU_PRICE_CEILING_USD}/hour ceiling`);
    requireValue(Number(budget.Budget?.BudgetLimit?.Amount) === 25 && budget.Budget.BudgetLimit.Unit === "USD", "Gross $25 budget missing");
    requireValue(expiry.State === "Active" && expiry.LastUpdateStatus === "Successful" &&
      expiry.Environment?.Variables?.MAX_AGE_MINUTES === "120" && rule.State === "ENABLED" &&
      rule.ScheduleExpression === "rate(5 minutes)" && targets.Targets?.some((target) => target.Arn === expiry.FunctionArn),
    "Automated expiry guard unavailable");
    const otherInstances = instances(existing).filter((instance) => tags(instance.Tags).AgentCloudJobId !== job?.id);
    requireValue(otherInstances.length === 0, "Another demo instance is active; reconcile it before launching");
    // Leftover rules from earlier jobs would otherwise open this new box to an old address.
    if (revokeStale) await revokeStaleSshRules(job?.id || null);
    return { launchTemplateId: template.LaunchTemplateId, subnetId, availabilityZone: s.AvailabilityZone, hourlyComputeUsd: price };
  }

  // `capMinutes` shortens the deadline tag and on-box timer (the smoke test uses 20).
  async function allocate(job, { authorizedKeys, capMinutes } = {}) {
    requireValue(job?.provider === "aws-ec2" && job.profile_id === "aws-cpu" && JOB_ID.test(job.id || ""), "Invalid approved CPU job");
    await base.identifyWorker();
    const prior = await base.find(job.id);
    if (prior) return prior;
    const checked = await preflight(job);
    const start = now();
    const minutes = lifetimeMinutes(job, start, capMinutes);
    const createdAt = start.toISOString();
    const expiresAt = new Date(start.getTime() + minutes * 60_000).toISOString();
    const userData = buildCpuUserData({ jobId: job.id, authorizedKeys, lifetimeMinutes: minutes });
    const instanceTags = [
      { Key: "Project", Value: "AgentCloudDemo" }, { Key: "AgentCloudAutoExpire", Value: "true" },
      { Key: "AgentCloudProfile", Value: "aws-cpu" },
      { Key: "AgentCloudJobId", Value: job.id }, { Key: "AgentCloudProjectId", Value: job.project_id },
      { Key: "AgentCloudCreatedAt", Value: createdAt }, { Key: "AgentCloudExpiresAt", Value: expiresAt },
      { Key: "AgentCloudInstall", Value: base.installId },
    ];
    const result = await aws("ec2", "run-instances", "--region", REGION, "--cli-input-json", JSON.stringify({
      ClientToken: job.id,
      MinCount: 1, MaxCount: 1,
      LaunchTemplate: { LaunchTemplateId: checked.launchTemplateId, Version: "$Default" },
      SubnetId: checked.subnetId,
      UserData: Buffer.from(userData).toString("base64"),
      TagSpecifications: [
        { ResourceType: "instance", Tags: instanceTags },
        { ResourceType: "volume", Tags: instanceTags.filter(({ Key }) =>
          ["Project", "AgentCloudAutoExpire", "AgentCloudProfile", "AgentCloudJobId", "AgentCloudProjectId"].includes(Key)) },
      ],
    }));
    const instance = result.Instances?.[0];
    requireValue(instance?.InstanceId && tags(instance.Tags).AgentCloudJobId === job.id, "EC2 allocation response lacked the approved job tag");
    return { ...instance, expiresAt, hourlyComputeUsd: checked.hourlyComputeUsd };
  }

  // One non-blocking SSM probe; the worker retries on its next cycle while pending.
  async function readHostKey(instanceId) {
    await base.identifyWorker();
    requireValue(/^i-[0-9a-f]+$/.test(instanceId || ""), "Invalid EC2 instance ID");
    const managed = await aws("ssm", "describe-instance-information", "--region", REGION,
      "--filters", `Key=InstanceIds,Values=${instanceId}`);
    if (!managed.InstanceInformationList?.some((item) => item.InstanceId === instanceId && item.PingStatus === "Online"))
      return { state: "pending", step: "ssm-registration" };
    const sent = await aws("ssm", "send-command", "--region", REGION, "--cli-input-json", JSON.stringify({
      InstanceIds: [instanceId], DocumentName: "AWS-RunShellScript", TimeoutSeconds: 60,
      Parameters: { commands: [HOST_KEY_READBACK], executionTimeout: ["60"] },
    }));
    const commandId = sent.Command?.CommandId;
    requireValue(commandId, "SSM did not return a command ID");
    let invocation;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(2_000);
      try {
        invocation = await aws("ssm", "get-command-invocation", "--region", REGION, "--command-id", commandId, "--instance-id", instanceId);
      } catch (error) {
        if (String(error.message).includes("InvocationDoesNotExist")) continue;
        throw error;
      }
      if (["Success", "Failed", "Cancelled", "TimedOut", "Cancelling"].includes(invocation.Status)) break;
    }
    // Early in boot the agent can report Online and still drop the command (for example while
    // bootstrap restarts it). That is not a failed readback: retry on the next worker cycle,
    // bounded by the worker's bootstrap deadline. A script that ran and failed still fails.
    const undelivered = !invocation || ["Pending", "InProgress", "Delayed", "TimedOut", "Cancelled", "Cancelling"].includes(invocation.Status) ||
      (invocation.Status === "Failed" && ["Undeliverable", "DeliveryTimedOut", "Terminated"].includes(invocation.StatusDetails));
    if (undelivered) return { state: "pending", step: "ssm-delivery" };
    requireValue(invocation.Status === "Success" && invocation.ResponseCode === 0, `Host key readback failed (SSM ${commandId})`);
    return { ...parseHostKeyReadback(invocation.StandardOutputContent || ""), commandId };
  }

  async function checkAgent(job, connection) {
    const result = await ssh(connection, agentCheckScript(job));
    if (result.code !== 0) {
      const hostKey = /Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(result.stderr || "");
      const error = new Error(hostKey ? "CPU environment host key did not match the pinned key" : `CPU SSH agent check failed (exit ${result.code})`);
      error.hostKeyMismatch = hostKey;
      error.retryable = !hostKey && result.code === 255;
      throw error;
    }
    return parseAgentCheck(result.stdout, job);
  }

  // Revoke first so the address loses access at once, then confirm instance/EBS release.
  async function terminateInstance(id) {
    const instance = await base.inspectInstance(id);
    const jobId = tags(instance?.Tags).AgentCloudJobId;
    if (JOB_ID.test(jobId || "")) await revokeSshForJob(jobId);
    return base.terminateInstance(id);
  }

  return { ...base, preflight, allocate, authorizeSsh, revokeSshForJob, revokeStaleSshRules, readHostKey, checkAgent, terminateInstance };
}

// Optional external probe from the worker host: the public endpoint must serve the pinned key.
export async function scanPublicHostKey(host, { run = execFileAsync } = {}) {
  requireValue(isIP(host || "") === 4, "Invalid public IPv4 address");
  const { stdout } = await run("ssh-keyscan", ["-T", "10", "-p", "22", "-t", "ed25519", host], { timeout: 20_000 });
  const line = String(stdout).split("\n").find((entry) => entry.startsWith(`${host} ssh-ed25519 `));
  requireValue(line, "Public SSH endpoint returned no ed25519 host key");
  return normalizePublicKey(line.slice(host.length + 1));
}
