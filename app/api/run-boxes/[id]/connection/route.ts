import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { failure } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { getRunBoxJob, migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";
import { listSshKeys, migrateSshKeys } from "../../../../../lib/ssh-keys.mjs";
import { runBoxVisibleTo } from "../../../../../lib/run-box-access.mjs";
import { getRunBoxSshEndpoint, knownHostsLine, migrateRunBoxSsh } from "../../../../../lib/run-box-ssh.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    const { id } = await context.params;
    if (typeof id !== "string" || !id || id.length > 64) throw new InputError("Run-box job not found", 404);
    const db = getDatabase();
    migrateRunBoxJobs(db);
    migrateRunBoxSsh(db);
    migrateSshKeys(db);
    const job = getRunBoxJob(db, id);
    if (!job) throw new InputError("Run-box job not found", 404);
    requireMembership(employee, job.project_id);
    // Environment model: deleted jobs and other people's private jobs do not exist here.
    if (!runBoxVisibleTo(db, employee, job.id)) throw new InputError("Run-box job not found", 404);
    if (job.state !== "ready") throw new InputError("Environment is not ready", 409);
    const endpoint = getRunBoxSshEndpoint(db, id);
    if (!endpoint) throw new InputError("Environment has no SSH endpoint", 409);
    const injected = new Set(endpoint.authorizedFingerprints);
    const keys = listSshKeys(db, employee.id) as { fingerprint: string }[];
    if (!keys.some((key) => injected.has(key.fingerprint)))
      return Response.json({
        error: "None of your device SSH keys is installed on this environment. It may have been created on the web before this device registered its key. Keep the desktop app signed in and retry in a minute; if it is still missing, create a new environment.",
        code: "no_authorized_key",
      }, { status: 403 });
    return Response.json({
      runBoxId: job.id,
      projectId: job.project_id,
      provider: job.provider,
      profileId: job.profile_id,
      state: job.state,
      host: endpoint.host,
      port: endpoint.port,
      username: endpoint.username,
      hostPublicKey: endpoint.hostPublicKey,
      knownHostsLine: knownHostsLine(endpoint),
      access: "trusted-shell",
      authorized: true,
    });
  } catch (error) {
    return failure(error);
  }
}
