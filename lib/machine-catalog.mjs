// AWS machine catalog: the fixed sizes an environment can be requested with. It is the
// shared contract between the run-box API (allowlist), the aws-ec2 worker (instance type,
// disk, price ceiling), Terraform (launch templates and the IAM ec2:InstanceType allowlist,
// which must list exactly these types), and the web picker.
//
// Every machine runs one environment through the same path as `aws-cpu`: public IPv4,
// per-job /32 SSH rules, a pinned host key, and Codex installed at bootstrap. GPU machines
// use a launch template whose AMI ships NVIDIA drivers. All GPU sizes are 4 vCPU so one
// fits the account's "Running On-Demand G and VT instances" quota (4 vCPU as of 2026-09-27).
//
// Dated planning quotes (AWS Price List, us-east-1, on-demand Linux, 2026-09-27). The worker
// re-prices from the Price List before launch and refuses above `maxHourlyUsd`.

export const MACHINE_QUOTED_AT = "2026-09-27";

/** @typedef {"cpu" | "gpu"} MachineKind */
/**
 * @typedef {{
 *   id: string, kind: MachineKind, size: string, instanceType: string,
 *   vcpu: number, memoryGib: number, gpu: null | { model: string, count: number, memoryGib: number },
 *   hourlyComputeUsd: number, maxHourlyUsd: number, launchTemplate: "agentcloud-demo-cpu" | "agentcloud-demo-gpu-env",
 * }} Machine
 */

/** @type {readonly Machine[]} */
export const machines = Object.freeze([
  // `aws-cpu` keeps its original id so existing jobs, tests, and links stay valid.
  { id: "aws-cpu", kind: "cpu", size: "Small", instanceType: "t3.medium", vcpu: 2, memoryGib: 4, gpu: null,
    hourlyComputeUsd: 0.0416, maxHourlyUsd: 0.1, launchTemplate: "agentcloud-demo-cpu" },
  { id: "aws-cpu-medium", kind: "cpu", size: "Medium", instanceType: "t3.xlarge", vcpu: 4, memoryGib: 16, gpu: null,
    hourlyComputeUsd: 0.1664, maxHourlyUsd: 0.25, launchTemplate: "agentcloud-demo-cpu" },
  { id: "aws-cpu-large", kind: "cpu", size: "Large", instanceType: "m7i.2xlarge", vcpu: 8, memoryGib: 32, gpu: null,
    hourlyComputeUsd: 0.4032, maxHourlyUsd: 0.5, launchTemplate: "agentcloud-demo-cpu" },
  { id: "aws-gpu-t4", kind: "gpu", size: "T4", instanceType: "g4dn.xlarge", vcpu: 4, memoryGib: 16,
    gpu: { model: "NVIDIA T4", count: 1, memoryGib: 16 },
    hourlyComputeUsd: 0.526, maxHourlyUsd: 0.7, launchTemplate: "agentcloud-demo-gpu-env" },
  { id: "aws-gpu-l4", kind: "gpu", size: "L4", instanceType: "g6.xlarge", vcpu: 4, memoryGib: 16,
    gpu: { model: "NVIDIA L4", count: 1, memoryGib: 24 },
    hourlyComputeUsd: 0.8048, maxHourlyUsd: 1.0, launchTemplate: "agentcloud-demo-gpu-env" },
  { id: "aws-gpu-a10g", kind: "gpu", size: "A10G", instanceType: "g5.xlarge", vcpu: 4, memoryGib: 16,
    gpu: { model: "NVIDIA A10G", count: 1, memoryGib: 24 },
    hourlyComputeUsd: 1.006, maxHourlyUsd: 1.25, launchTemplate: "agentcloud-demo-gpu-env" },
]);

// gp3 root volume. CPU AMIs fit in 20 GiB. The GPU template's AMI (Deep Learning Base OSS
// Nvidia Driver, Amazon Linux 2023) ships a 75 GiB root snapshot, and EC2 refuses a root
// volume smaller than its snapshot, so GPU machines start at 100 GiB (checked 2026-09-27).
export const diskOptionsGib = Object.freeze([20, 50, 100]);
export const GP3_USD_PER_GIB_MONTH = 0.08;
export const PUBLIC_IPV4_USD_PER_HOUR = 0.005;
export function minDiskGib(machine) { return machine.kind === "gpu" ? 100 : 20; }
export function defaultDiskGib(machine) { return minDiskGib(machine); }

export function findMachine(id) {
  return machines.find((machine) => machine.id === id) ?? null;
}

/** Validates a requested disk size for a machine; returns the size or throws. */
export function resolveDiskGib(machine, requested) {
  const disk = requested === undefined || requested === null ? defaultDiskGib(machine) : requested;
  if (!diskOptionsGib.includes(disk) || disk < minDiskGib(machine))
    throw new Error(`Disk must be one of ${diskOptionsGib.filter((gib) => gib >= minDiskGib(machine)).join(", ")} GiB for ${machine.size}`);
  return disk;
}

/** Planning estimate only: compute + public IPv4 + gp3 disk, per hour. */
export function estimateHourlyUsd(machine, diskGib) {
  return machine.hourlyComputeUsd + PUBLIC_IPV4_USD_PER_HOUR + (diskGib * GP3_USD_PER_GIB_MONTH) / 730;
}
