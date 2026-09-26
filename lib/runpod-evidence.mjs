export function migrateRunpodEvidence(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS runpod_gpu_verification (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id),
    pod_id TEXT NOT NULL, remote_account TEXT NOT NULL, remote_uid INTEGER NOT NULL,
    workspace TEXT NOT NULL, repo_revision TEXT NOT NULL, gpu_device TEXT NOT NULL,
    nvidia_probe TEXT NOT NULL, workload_value REAL NOT NULL, correctness INTEGER NOT NULL,
    cpu_ms REAL NOT NULL, gpu_ms REAL NOT NULL, duration_ms INTEGER NOT NULL,
    output_sha256 TEXT NOT NULL, evidence_ref TEXT NOT NULL, verified_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS runpod_connection_wait (
    job_id TEXT PRIMARY KEY REFERENCES run_box_job(id), reason TEXT NOT NULL, updated_at TEXT NOT NULL
  );`);
}

export function recordRunpodConnectionWait(db, jobId, reason) {
  db.prepare(`INSERT INTO runpod_connection_wait (job_id, reason, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET reason=excluded.reason, updated_at=excluded.updated_at`)
    .run(jobId, reason, new Date().toISOString());
}

export function saveRunpodEvidence(db, jobId, podId, proof) {
  if (!proof || proof.account !== "agentcloud" || !Number.isInteger(proof.uid) || proof.uid <= 0 ||
      proof.workspace !== `/home/agentcloud/agentcloud/${jobId}` ||
      !/^[a-f0-9]{40,64}$/.test(proof.repo_sha || "") ||
      typeof proof.gpu_device !== "string" || !/RTX 4090/i.test(proof.gpu_device) || proof.gpu_device.length > 128 ||
      typeof proof.nvidia_probe !== "string" || !/RTX 4090/i.test(proof.nvidia_probe) || proof.nvidia_probe.length > 256 ||
      proof.correct !== true || !Number.isFinite(proof.workload_value) || Math.abs(proof.workload_value - 4) >= .001 ||
      !Number.isFinite(proof.cpu_ms) || proof.cpu_ms <= 0 || !Number.isFinite(proof.gpu_ms) || proof.gpu_ms <= 0 ||
      !Number.isInteger(proof.elapsed_ms) || proof.elapsed_ms < 0 ||
      !/^[a-f0-9]{64}$/.test(proof.outputSha256 || "") ||
      proof.evidenceRef !== `ssh:${jobId}:${proof.outputSha256}`)
    throw new Error("Runpod GPU verification evidence is incomplete");
  const job = db.prepare("SELECT provider, provider_resource_id, repo_revision FROM run_box_job WHERE id = ?").get(jobId);
  if (job?.provider !== "runpod" || job.provider_resource_id !== podId || job.repo_revision !== proof.repo_sha)
    throw new Error("Runpod GPU evidence does not match approved job and repository revision");
  db.prepare(`INSERT INTO runpod_gpu_verification
    (job_id, pod_id, remote_account, remote_uid, workspace, repo_revision, gpu_device, nvidia_probe,
      workload_value, correctness, cpu_ms, gpu_ms, duration_ms, output_sha256, evidence_ref, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET pod_id=excluded.pod_id, remote_account=excluded.remote_account,
      remote_uid=excluded.remote_uid, workspace=excluded.workspace, repo_revision=excluded.repo_revision,
      gpu_device=excluded.gpu_device, nvidia_probe=excluded.nvidia_probe,
      workload_value=excluded.workload_value, correctness=excluded.correctness,
      cpu_ms=excluded.cpu_ms, gpu_ms=excluded.gpu_ms, duration_ms=excluded.duration_ms,
      output_sha256=excluded.output_sha256, evidence_ref=excluded.evidence_ref,
      verified_at=excluded.verified_at`).run(jobId, podId, proof.account, proof.uid, proof.workspace,
    proof.repo_sha, proof.gpu_device, proof.nvidia_probe, proof.workload_value, 1,
    proof.cpu_ms, proof.gpu_ms, proof.elapsed_ms, proof.outputSha256, proof.evidenceRef,
    new Date().toISOString());
  db.prepare("DELETE FROM runpod_connection_wait WHERE job_id = ?").run(jobId);
}
