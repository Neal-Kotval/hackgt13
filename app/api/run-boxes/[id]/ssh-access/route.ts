import { getDatabase } from "../../../../../lib/auth.mjs";
import { requireEmployee, requireMembership, type Employee } from "../../../../../lib/employee";
import { runBoxVisibleTo } from "../../../../../lib/run-box-access.mjs";
import { failure, sameOrigin } from "../../../../../lib/http";
import { InputError } from "../../../../../lib/store";
import { getRunBoxJob, isAwsMachineProfile, migrateRunBoxJobs } from "../../../../../lib/run-box-jobs.mjs";
import {
  TRUST_CLOUDFRONT_VIEWER_ENV, getAwsCpuSshAccess, requestAwsCpuSshAccess, trustedRequesterCidr,
} from "../../../../../lib/aws-cpu-ssh-access.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HAC-166: lets the desktop app admit its own network to an aws-cpu environment.
// The caller's public IPv4 comes only from CloudFront's viewer header, and only when
// AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1 (see lib/aws-cpu-ssh-access.mjs). The desktop
// makes this request over IPv4 so CloudFront sees the address its SSH connection uses.
// POST records the address for the worker (202 pending) or reports it applied (200).
// GET reports the caller's current address status without recording anything.

type Job = { id: string; project_id: string; profile_id: string | null; state: string; stop_requested_at: string | null };
type AccessRow = { cidr: string; status: string; error: string | null; applied_at: string | null };

function refuse(status: number, code: string, error: string) {
  return Response.json({ error, code }, { status });
}

async function eligibleJob(context: { params: Promise<{ id: string }> }, employee: Employee) {
  const { id } = await context.params;
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new InputError("Run-box job not found", 404);
  const db = getDatabase();
  migrateRunBoxJobs(db);
  const job = getRunBoxJob(db, id) as Job | undefined;
  if (!job) throw new InputError("Run-box job not found", 404);
  requireMembership(employee, job.project_id);
  // Environment model: deleted jobs and other people's private jobs do not exist here.
  if (!runBoxVisibleTo(db, employee, job.id)) throw new InputError("Run-box job not found", 404);
  // Every catalog machine (aws-cpu and the other CPU and GPU sizes) shares the aws-cpu SSH path.
  if (!isAwsMachineProfile(job.profile_id))
    return { db, job, refusal: refuse(409, "not_aws_cpu", "Network access is managed only for AWS EC2 environments.") };
  if (!["ready", "verifying"].includes(job.state) || job.stop_requested_at)
    return { db, job, refusal: refuse(409, "not_ready", "Environment is not ready for network access.") };
  if (process.env[TRUST_CLOUDFRONT_VIEWER_ENV] !== "1")
    return { db, job, refusal: refuse(409, "address_untrusted",
      "This server does not read requester addresses; the environment admits only its configured SSH source.") };
  return { db, job, refusal: null };
}

function noIpv4() {
  return refuse(409, "no_ipv4",
    "AgentCloud could not see a public IPv4 address for this device. Connect from a network with IPv4 internet access, then retry.");
}

function summary(row: AccessRow | null, cidr: string) {
  return {
    cidr,
    status: row && ["pending", "applied", "failed"].includes(row.status) ? row.status : "none",
    ...(row?.status === "failed" ? { error: "AgentCloud could not add a network rule for this address. Retry." } : {}),
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    sameOrigin(request);
    const { db, job, refusal } = await eligibleJob(context, employee);
    if (refusal) return refusal;
    const cidr = trustedRequesterCidr(request.headers);
    if (!cidr) return noIpv4();
    const row = requestAwsCpuSshAccess(db, { jobId: job.id, cidr, employeeId: employee.id, source: "desktop" }) as AccessRow;
    if (row.status === "applied") return Response.json({ status: "applied", cidr }, { status: 200 });
    return Response.json({ status: "pending", cidr }, { status: 202 });
  } catch (error) {
    return failure(error);
  }
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const employee = await requireEmployee(request);
    const { db, job, refusal } = await eligibleJob(context, employee);
    if (refusal) return refusal;
    const cidr = trustedRequesterCidr(request.headers);
    if (!cidr) return noIpv4();
    return Response.json({ sshAccess: summary(getAwsCpuSshAccess(db, job.id, cidr) as AccessRow | null, cidr) });
  } catch (error) {
    return failure(error);
  }
}
