import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { AWS_CPU_PROFILE_ID } from "./run-box-jobs.mjs";

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

// HAC-166 follow-up: `desktop` rows come from POST /api/run-boxes/:id/ssh-access. At
// most MAX_REQUESTER_CIDRS addresses are active per job; a new one replaces the oldest,
// which becomes `replaced` (the worker revokes its rule, then marks it `revoked`).
export const MAX_REQUESTER_CIDRS = 5;
const SOURCES = ["create", "refresh", "desktop"];
const TABLE = `CREATE TABLE IF NOT EXISTS aws_cpu_ssh_access (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES run_box_job(id),
    cidr TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('create', 'refresh', 'desktop')),
    requested_by TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'failed', 'replaced', 'revoked')),
    rule_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    last_requested_at TEXT NOT NULL,
    applied_at TEXT,
    updated_at TEXT NOT NULL
  )`;
const ACTIVE_INDEX = `CREATE UNIQUE INDEX IF NOT EXISTS aws_cpu_ssh_access_active
    ON aws_cpu_ssh_access(job_id, cidr) WHERE status IN ('pending', 'applied')`;

export function migrateAwsCpuSshAccess(db) {
  const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'aws_cpu_ssh_access'").get();
  if (existing && !existing.sql.includes("'desktop'")) {
    // The first HAC-166 table had narrower CHECKs; SQLite cannot alter them in place.
    db.transaction(() => {
      db.exec(`DROP INDEX IF EXISTS aws_cpu_ssh_access_active;
        ALTER TABLE aws_cpu_ssh_access RENAME TO aws_cpu_ssh_access_v1;`);
      db.exec(`${TABLE};`);
      db.exec(`INSERT INTO aws_cpu_ssh_access (id, job_id, cidr, source, requested_by, status, rule_id, error, created_at,
          last_requested_at, applied_at, updated_at)
        SELECT id, job_id, cidr, source, requested_by, status, rule_id, error, created_at, last_requested_at, applied_at, updated_at
        FROM aws_cpu_ssh_access_v1;
        DROP TABLE aws_cpu_ssh_access_v1;`);
      db.exec(`${ACTIVE_INDEX};`);
    })();
    return;
  }
  db.exec(`${TABLE}; ${ACTIVE_INDEX};`);
}

// Records a pending requester address for a job. An address that is already pending
// or applied for the job is only touched. Beyond MAX_REQUESTER_CIDRS active addresses
// the least recently requested one is replaced: a pending one never reached AWS and is
// revoked at once; an applied one is left for the worker to revoke.
export function requestAwsCpuSshAccess(db, { jobId, cidr, employeeId, source = "create", now = new Date() }) {
  if (!JOB_ID.test(jobId || "")) throw new Error("Invalid run-box job ID");
  if (typeof employeeId !== "string" || !employeeId || employeeId.length > 256) throw new Error("Invalid employee ID");
  if (!SOURCES.includes(source)) throw new Error("Invalid SSH access source");
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
    const current = db.prepare(`SELECT * FROM aws_cpu_ssh_access WHERE job_id = ? AND status IN ('pending', 'applied')
      ORDER BY last_requested_at, created_at, rowid`).all(jobId);
    for (const row of current.slice(0, Math.max(0, current.length - MAX_REQUESTER_CIDRS + 1)))
      db.prepare("UPDATE aws_cpu_ssh_access SET status = ?, updated_at = ? WHERE id = ?")
        .run(row.status === "applied" ? "replaced" : "revoked", at, row.id);
    const id = randomUUID();
    db.prepare(`INSERT INTO aws_cpu_ssh_access (id, job_id, cidr, source, requested_by, status, created_at, last_requested_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(id, jobId, address, source, employeeId, at, at, at);
    return { ...db.prepare("SELECT * FROM aws_cpu_ssh_access WHERE id = ?").get(id), created: true };
  })();
}

// The most recent record for one address on one job, or null.
export function getAwsCpuSshAccess(db, jobId, cidr) {
  migrateAwsCpuSshAccess(db);
  return db.prepare(`SELECT * FROM aws_cpu_ssh_access WHERE job_id = ? AND cidr = ?
    ORDER BY CASE WHEN status IN ('pending', 'applied') THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT 1`).get(jobId, cidr) || null;
}

export function listAwsCpuSshAccess(db, jobId) {
  migrateAwsCpuSshAccess(db);
  return db.prepare("SELECT * FROM aws_cpu_ssh_access WHERE job_id = ? ORDER BY last_requested_at, created_at, rowid").all(jobId);
}

function mark(db, id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE aws_cpu_ssh_access SET ${keys.map((key) => `${key} = @${key}`).join(", ")}, updated_at = @updated_at
    WHERE id = @id`).run({ ...fields, updated_at: new Date().toISOString(), id });
}

// Worker side. Revokes rules of `replaced` addresses, then adds a job-tagged tcp/22
// rule for every pending requester address of `job`. An address equal to the worker's
// (`keepCidr`) reuses the worker's rule (authorizeSsh dedupes by job and /32), so it is
// never revoked here. Termination's revokeSshForJob removes every rule tagged with the
// job. Failures are recorded per address and do not throw, so a bad address cannot
// block verification from the worker's own address or other jobs.
export async function applyAwsCpuSshAccess(db, provider, job, { keepCidr = null } = {}) {
  migrateAwsCpuSshAccess(db);
  const outcomes = [];
  const rows = listAwsCpuSshAccess(db, job.id);
  const activeCidrs = new Set(rows.filter((item) => ["pending", "applied"].includes(item.status)).map((item) => item.cidr));
  for (const row of rows.filter((item) => item.status === "replaced")) {
    try {
      if (row.cidr !== keepCidr && !activeCidrs.has(row.cidr)) await provider.revokeSshCidr(job, row.cidr);
      mark(db, row.id, { status: "revoked", error: null });
      outcomes.push({ jobId: job.id, cidr: row.cidr, status: "revoked" });
    } catch (error) {
      mark(db, row.id, { error: String(error?.message || error).slice(0, 256) });
      outcomes.push({ jobId: job.id, cidr: row.cidr, status: "revoke-failed" });
    }
  }
  for (const row of rows.filter((item) => item.status === "pending")) {
    try {
      const rule = await provider.authorizeSsh(job, row.cidr);
      const changed = db.prepare(`UPDATE aws_cpu_ssh_access SET status = 'applied', rule_id = ?, error = NULL, applied_at = ?,
        updated_at = ? WHERE id = ? AND status = 'pending'`).run(rule.ruleId, new Date().toISOString(), new Date().toISOString(), row.id);
      // Replaced while the rule was being added: take the rule back out.
      if (!changed.changes && row.cidr !== keepCidr) await provider.revokeSshCidr(job, row.cidr);
      outcomes.push({ jobId: job.id, cidr: row.cidr, status: changed.changes ? "applied" : "revoked" });
    } catch (error) {
      mark(db, row.id, { status: "failed", error: String(error?.message || error).slice(0, 256) });
      outcomes.push({ jobId: job.id, cidr: row.cidr, status: "failed" });
    }
  }
  return outcomes;
}

// Each worker cycle: requester addresses recorded after a job became ready (for example
// from the desktop app) are applied here. Only ready aws-cpu jobs without a stop request
// are touched; one job's failure is recorded and does not stop the others.
export async function applyReadyAwsCpuSshAccess(db, provider, { profileId = AWS_CPU_PROFILE_ID } = {}) {
  migrateAwsCpuSshAccess(db);
  const jobs = db.prepare(`SELECT j.* FROM run_box_job j WHERE j.provider = 'aws-ec2' AND j.profile_id = ?
    AND j.state = 'ready' AND j.stop_requested_at IS NULL
    AND EXISTS (SELECT 1 FROM aws_cpu_ssh_access a WHERE a.job_id = j.id AND a.status IN ('pending', 'replaced'))`).all(profileId);
  const hasEnvironment = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'aws_cpu_environment'").get());
  const outcomes = [];
  for (const job of jobs) {
    const keepCidr = hasEnvironment
      ? db.prepare("SELECT ssh_source_cidr FROM aws_cpu_environment WHERE job_id = ?").get(job.id)?.ssh_source_cidr ?? null
      : null;
    try { outcomes.push(...await applyAwsCpuSshAccess(db, provider, job, { keepCidr })); }
    catch (error) { outcomes.push({ jobId: job.id, status: "failed", error: String(error?.message || error).slice(0, 256) }); }
  }
  return outcomes;
}
