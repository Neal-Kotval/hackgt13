// Plain label for an approved run box. It claims a GPU only when the job's
// profile is a known GPU profile; a local Docker sandbox is always CPU only.
// Dependency-free so node:test can import it directly.

export type RunBoxLabelInput = { provider: string; profile_id?: string | null };

export function runBoxHardwareLabel(job: RunBoxLabelInput, gpuProfileLabels: Record<string, string>) {
  if (job.provider === "docker-local") return "Local sandbox · CPU only";
  const label = job.profile_id ? gpuProfileLabels[job.profile_id] : undefined;
  if (label) return `GPU · ${label}`;
  // Every Runpod profile is a GPU. AWS jobs created before profiles were recorded
  // used the only AWS profile, which was a GPU.
  if (job.provider === "runpod") return "GPU · Runpod";
  if (job.provider === "aws-ec2" && job.profile_id == null) return "GPU · AWS EC2";
  return `${job.provider === "aws-ec2" ? "AWS EC2" : job.provider} · CPU only`;
}
