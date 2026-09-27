import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership } from "../../../../../lib/employee";
import { failure } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { getRunBoxJob, isAwsMachineProfile, migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";
import { listSshKeys, migrateSshKeys } from "../../../../../lib/ssh-keys.mjs";
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
      // Catalog AWS machines admit SSH only from registered /32s: the desktop must first
      // register its IPv4 through POST /api/run-boxes/:id/ssh-access (HAC-166).
      networkAccess: isAwsMachineProfile(job.profile_id) ? "requester-ipv4" : null,
      authorized: true,
    });
  } catch (error) {
    return failure(error);
  }
}
