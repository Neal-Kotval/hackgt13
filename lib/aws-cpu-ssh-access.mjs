import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

// Requester SSH access for aws-cpu environments (HAC-166).
//
// An aws-cpu box admits tcp/22 only from tagged /32 rules. The worker's own address
// is always admitted (it verifies the box and the backend runs Codex from the same
// host). On staging the requester's desktop is on a different network, so the app
// records the requester's public IPv4 when an environment is created or when a member
// asks to refresh access, and the worker adds a rule for it on its next cycle.
//
// The requester address comes only from CloudFront's `CloudFront-Viewer-Address`
// header, and only when AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1. That flag is safe only
// where the origin is reachable exclusively through CloudFront (staging: the app port
// admits only the CloudFront origin-facing prefix list), because CloudFront sets this
// header itself. Without the flag every header is ignored; X-Forwarded-For is never used.

export const TRUST_CLOUDFRONT_VIEWER_ENV = "AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER";
const JOB_ID = /^[a-f0-9-]{36}$/;
const DOTTED = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

// Public unicast IPv4 only. Rejects "this network", private, CGNAT, loopback,
// link-local, IETF protocol assignments, benchmarking, multicast, and reserved
// (including broadcast). Documentation ranges (TEST-NET-1/2/3) are not routable on
// the internet, so a real viewer address never carries them; tests use them.
export function isPublicIpv4(ip) {
  if (typeof ip !== "string" || !DOTTED.test(ip) || isIP(ip) !== 4) return false;
  const [a, b, c] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)));
}

// `CloudFront-Viewer-Address` is `ip:port`. IPv4 is `a.b.c.d:port`; IPv6 appears as
// `2001:db8::1:443` (bare) or `[2001:db8::1]:443`. Only a public IPv4 is returned;
// IPv6, lists, whitespace, and malformed values yield null.
export function parseCloudFrontViewerAddress(value) {
  if (typeof value !== "string" || value.length > 64 || !/^[0-9.:]+$/.test(value)) return null;
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const [ip, port] = parts;
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return isPublicIpv4(ip) ? ip : null;
}

// Returns `<ip>/32` for the trusted requester, or null.
export function trustedRequesterCidr(headers, env = process.env) {
  if (env?.[TRUST_CLOUDFRONT_VIEWER_ENV] !== "1") return null;
  const ip = parseCloudFrontViewerAddress(headers?.get?.("cloudfront-viewer-address") ?? null);
  return ip ? `${ip}/32` : null;
}

function requesterCidr(value) {
  const [ip, prefix] = String(value ?? "").split("/");
  if (prefix !== "32" || !isPublicIpv4(ip)) throw new Error("Requester address must be a public IPv4 /32");
  return `${ip}/32`;
}

export function migrateAwsCpuSshAccess(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS aws_cpu_ssh_access (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES run_box_job(id),
    cidr TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('create', 'refresh')),
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'failed')),
    rule_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    last_requested_at TEXT NOT NULL,
    applied_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS aws_cpu_ssh_access_active
    ON aws_cpu_ssh_access(job_id, cidr) WHERE status IN ('pending', 'applied');`);
}

// Records a pending requester address for a job. An address that is already pending
// or applied for the job is only touched.
export function requestAwsCpuSshAccess(db, { jobId, cidr, employeeId, source = "create", now = new Date() }) {
  if (!JOB_ID.test(jobId || "")) throw new Error("Invalid run-box job ID");
  if (typeof employeeId !== "string" || !employeeId || employeeId.length > 256) throw new Error("Invalid employee ID");
  if (!["create", "refresh"].includes(source)) throw new Error("Invalid SSH access source");
  const address = requesterCidr(cidr);
  migrateAwsCpuSshAccess(db);
  const at = now.toISOString();
  return db.transaction(() => {
    const active = db.prepare(`SELECT * FROM aws_cpu_ssh_access WHERE job_id = ? AND cidr = ?
      AND status IN ('pending', 'applied')`).get(jobId, address);
    if (active) {
      db.prepare("UPDATE aws_cpu_ssh_access SET last_requested_at = ?, updated_at = ? WHERE id = ?").run(at, at, active.id);
      return { ...active, last_requested_at: at, updated_at: at, created: false };
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO aws_cpu_ssh_access (id, job_id, cidr, source, requested_by, status, created_at, last_requested_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, jobId, address, source, employeeId, at, at, at);
    return { ...db.prepare("SELECT * FROM aws_cpu_ssh_access WHERE id = ?").get(id), created: true };
  })();
}

export function listAwsCpuSshAccess(db, jobId) {
  migrateAwsCpuSshAccess(db);
  return db.prepare("SELECT * FROM aws_cpu_ssh_access WHERE job_id = ? ORDER BY last_requested_at, created_at, id").all(jobId);
}

function mark(db, id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE aws_cpu_ssh_access SET ${keys.map((key) => `${key} = @${key}`).join(", ")}, updated_at = @updated_at
    WHERE id = @id`).run({ ...fields, updated_at: new Date().toISOString(), id });
}

// Worker side. Adds a job-tagged tcp/22 rule for every pending requester address of
// `job`. An address equal to the worker's reuses the worker's rule (authorizeSsh
// dedupes by job and /32). Termination's revokeSshForJob removes every rule tagged
// with the job. Failures are recorded per address and do not throw, so a bad address
// cannot block verification from the worker's own address.
export async function applyAwsCpuSshAccess(db, provider, job) {
  migrateAwsCpuSshAccess(db);
  const outcomes = [];
  for (const row of listAwsCpuSshAccess(db, job.id).filter((item) => item.status === "pending")) {
    try {
      const rule = await provider.authorizeSsh(job, row.cidr);
      mark(db, row.id, { status: "applied", rule_id: rule.ruleId, error: null, applied_at: new Date().toISOString() });
      outcomes.push({ jobId: job.id, cidr: row.cidr, status: "applied" });
    } catch (error) {
      mark(db, row.id, { status: "failed", error: String(error?.message || error).slice(0, 256) });
      outcomes.push({ jobId: job.id, cidr: row.cidr, status: "failed" });
    }
  }
  return outcomes;
}
