// Dated planning quote. Re-price on the server before any future allocation.
export const demoGpuProfile = {
  id: "g6-l4-small",
  provider: "aws-ec2",
  region: "us-east-1",
  instanceType: "g6.xlarge",
  label: "Small GPU · NVIDIA L4",
  hourlyComputeUsd: 0.8048,
  quotedAt: "2026-09-26",
} as const;

export const demoGpuDurations = [1, 2] as const;
