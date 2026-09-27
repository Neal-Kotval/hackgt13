import { migrateRunBoxJobs } from "./run-box-jobs.mjs";
import { getRunBoxSshEndpoint, migrateRunBoxSsh } from "./run-box-ssh.mjs";
import { getAgentCheck, getWorkspacePath, migrateAgentCheck } from "./agent-check.mjs";

// Read-only view of an environment as a Codex session target (HAC-153).
export function createRunBoxTargets(db) {
  let migrated = false;
  return {
    describe(runBoxId) {
      if (!migrated) { migrateRunBoxJobs(db); migrateRunBoxSsh(db); migrateAgentCheck(db); migrated = true; }
      const job = db.prepare("SELECT id, project_id, provider, profile_id, state, stop_requested_at FROM run_box_job WHERE id = ?").get(runBoxId);
      if (!job) return null;
      const endpoint = getRunBoxSshEndpoint(db, job.id);
      return {
        runBoxId: job.id, projectId: job.project_id, provider: job.provider, profileId: job.profile_id,
        state: job.state, stopRequested: Boolean(job.stop_requested_at),
        codexState: getAgentCheck(db, job.id, "codex").state,
        workspacePath: job.state === "ready" ? getWorkspacePath(db, job.id) : null,
        serverKeyInstalled: Boolean(endpoint?.serverFingerprint),
      };
    },
  };
}
