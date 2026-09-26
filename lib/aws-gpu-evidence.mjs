export function migrateAwsGpuEvidence(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aws_gpu_verification (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
    instance_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    remote_account TEXT NOT NULL,
    remote_uid INTEGER NOT NULL,
    workspace TEXT NOT NULL,
    repo_revision TEXT NOT NULL,
    gpu_device TEXT NOT NULL,
    nvidia_probe TEXT NOT NULL,
    workload_value REAL NOT NULL,
    correctness INTEGER NOT NULL,
    cpu_ms REAL NOT NULL,
    gpu_ms REAL NOT NULL,
    duration_ms INTEGER NOT NULL,
    exit_code INTEGER NOT NULL,
    output_sha256 TEXT NOT NULL,
    verified_at TEXT NOT NULL
  );`);
}

export function saveAwsGpuEvidence(db, jobId, evidence) {
  if (!evidence || evidence.exitCode !== 0 || !/^i-[0-9a-f]+$/.test(evidence.instanceId || "") ||
      !/^[a-f0-9]{40,64}$/.test(evidence.repositoryRevision || "") ||
      !/^[a-f0-9]{64}$/.test(evidence.outputSha256 || "") ||
      typeof evidence.gpuDevice !== "string" || !evidence.gpuDevice || evidence.gpuDevice.length > 128 ||
      typeof evidence.nvidiaProbe !== "string" || !evidence.nvidiaProbe || evidence.nvidiaProbe.length > 256 ||
      !Number.isInteger(evidence.remoteUid) || evidence.remoteUid <= 0 ||
      evidence.correct !== true || !Number.isFinite(evidence.workloadValue) || Math.abs(evidence.workloadValue - 4) >= 0.001 ||
      !Number.isFinite(evidence.cpuMs) || evidence.cpuMs <= 0 ||
      !Number.isFinite(evidence.gpuMs) || evidence.gpuMs <= 0 ||
      !Number.isInteger(evidence.durationMs) || evidence.durationMs < 0 ||
      evidence.remoteAccount !== "ec2-user" || evidence.workspace !== `/home/ec2-user/agentcloud/${jobId}` ||
      typeof evidence.commandId !== "string" || !/^[a-f0-9-]{8,64}$/.test(evidence.commandId))
    throw new Error("GPU verification evidence is incomplete");
  const job = db.prepare("SELECT id, provider_resource_id, repo_revision FROM run_box_job WHERE id = ?").get(jobId);
  if (!job || job.provider_resource_id !== evidence.instanceId || job.repo_revision !== evidence.repositoryRevision)
    throw new Error("GPU evidence does not match allocated job and repository revision");
  db.prepare(`INSERT INTO aws_gpu_verification
    (job_id, instance_id, command_id, remote_account, remote_uid, workspace, repo_revision, gpu_device, nvidia_probe, workload_value, correctness, cpu_ms, gpu_ms, duration_ms, exit_code, output_sha256, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET
      instance_id=excluded.instance_id, command_id=excluded.command_id,
      remote_account=excluded.remote_account, remote_uid=excluded.remote_uid,
      workspace=excluded.workspace, repo_revision=excluded.repo_revision,
      gpu_device=excluded.gpu_device, nvidia_probe=excluded.nvidia_probe,
      workload_value=excluded.workload_value, correctness=excluded.correctness,
      cpu_ms=excluded.cpu_ms, gpu_ms=excluded.gpu_ms,
      duration_ms=excluded.duration_ms, exit_code=excluded.exit_code,
      output_sha256=excluded.output_sha256, verified_at=excluded.verified_at`).run(
      jobId, evidence.instanceId, evidence.commandId, evidence.remoteAccount, evidence.remoteUid,
      evidence.workspace, evidence.repositoryRevision, evidence.gpuDevice, evidence.nvidiaProbe,
      evidence.workloadValue, 1, evidence.cpuMs, evidence.gpuMs,
      evidence.durationMs, evidence.exitCode, evidence.outputSha256, new Date().toISOString(),
    );
}
