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

// The Runpod worker rechecks catalog availability and price before creating a
// Pod. This is a maximum authorized rate, not a price quote.
export const runpodGpuProfile = {
  id: "runpod-rtx-4090",
  provider: "runpod",
  gpuId: "NVIDIA GeForce RTX 4090",
  image: "runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
  cloud: "SECURE",
  diskGb: 50,
  maxHourlyUsd: 1,
  label: "Runpod Secure Cloud · RTX 4090",
} as const;

// CPU-only Linux container on the machine running the docker-local worker.
// Never present it as GPU capacity.
export const localDockerSandboxProfile = {
  id: "local-docker-sandbox",
  provider: "docker-local",
  label: "Local Docker sandbox · CPU only",
  description:
    "CPU-only Linux container on the machine running the worker. No GPU. Costs nothing. SSH access is trusted shell access, not a filesystem or command sandbox.",
  gpu: null,
  hourlyComputeUsd: 0,
} as const;

export const demoGpuDurations = [1, 2] as const;
