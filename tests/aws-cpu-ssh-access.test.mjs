import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { migrateRunBoxJobs } from "../lib/run-box-jobs.mjs";
import {
  applyAwsCpuSshAccess, applyReadyAwsCpuSshAccess, isPublicIpv4, listAwsCpuSshAccess, MAX_REQUESTER_CIDRS, parseCloudFrontViewerAddress, requestAwsCpuSshAccess,
  trustedRequesterCidr,
} from "../lib/aws-cpu-ssh-access.mjs";

const jobId = "44444444-4444-4444-8444-444444444444";
const trusted = { AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER: "1" };

test("CloudFront-Viewer-Address yields only a public IPv4", () => {
  assert.equal(parseCloudFrontViewerAddress("8.8.8.8:46532"), "8.8.8.8");
  assert.equal(parseCloudFrontViewerAddress("184.192.120.7:1"), "184.192.120.7");
  for (const bad of [
    "10.0.0.5:443", "172.16.0.1:443", "192.168.1.2:443", "127.0.0.1:443", "169.254.169.254:80", "100.64.0.1:443",
    "0.1.2.3:443", "224.0.0.1:443", "239.1.1.1:443", "240.0.0.1:443", "255.255.255.255:443", "192.0.0.8:443", "198.18.0.1:443",
    "[2001:db8::1]:443", "2001:db8::1:443", "::ffff:8.8.8.8:443", "8.8.8.8", "8.8.8.8:0", "8.8.8.8:65536", "8.8.8.8:x",
    "08.8.8.8:443", "8.8.8.8:443, 1.1.1.1:443", " 8.8.8.8:443", "", null, undefined,
  ]) assert.equal(parseCloudFrontViewerAddress(bad), null, String(bad));
  assert.equal(isPublicIpv4("1.1.1.1"), true);
  assert.equal(isPublicIpv4("100.128.0.1"), true);
});

test("the header is trusted only with AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER=1; X-Forwarded-For never", () => {
  const headers = new Headers({ "CloudFront-Viewer-Address": "8.8.8.8:5000", "X-Forwarded-For": "1.1.1.1" });
  assert.equal(trustedRequesterCidr(headers, {}), null);
  assert.equal(trustedRequesterCidr(headers, { AGENTCLOUD_TRUST_CLOUDFRONT_VIEWER: "true" }), null);
  assert.equal(trustedRequesterCidr(headers, trusted), "8.8.8.8/32");
  assert.equal(trustedRequesterCidr(new Headers({ "X-Forwarded-For": "1.1.1.1" }), trusted), null);
  assert.equal(trustedRequesterCidr(new Headers({ "CloudFront-Viewer-Address": "10.1.2.3:5000" }), trusted), null);
  assert.equal(trustedRequesterCidr(new Headers({ "CloudFront-Viewer-Address": "2a05:d014::1:5000" }), trusted), null);
});

function database() {
  const db = new Database(":memory:");
  migrateRunBoxJobs(db);
  // The job row itself is not under test here.
  db.pragma("foreign_keys = OFF");
  return db;
}

test("a requester address is recorded once per job and applied as a job-tagged rule", async () => {
  const db = database();
  try {
    const first = requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.8.8/32", employeeId: "employee-1" });
    const again = requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.8.8/32", employeeId: "employee-1" });
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.throws(() => requestAwsCpuSshAccess(db, { jobId, cidr: "10.0.0.1/32", employeeId: "employee-1" }), /public IPv4/);
    const calls = [];
    const provider = { async authorizeSsh(job, cidr) { calls.push([job.id, cidr]); return { ruleId: "sgr-0aa", cidr }; } };
    assert.deepEqual((await applyAwsCpuSshAccess(db, provider, { id: jobId })).map((item) => item.status), ["applied"]);
    assert.deepEqual(calls, [[jobId, "8.8.8.8/32"]]);
    const [row] = listAwsCpuSshAccess(db, jobId);
    assert.equal(row.status, "applied");
    assert.equal(row.rule_id, "sgr-0aa");
    // Applied rows are not re-authorized on later cycles.
    await applyAwsCpuSshAccess(db, provider, { id: jobId });
    assert.equal(calls.length, 1);
  } finally { db.close(); }
});

test("a failed requester rule is recorded and does not throw", async () => {
  const db = database();
  try {
    requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.4.4/32", employeeId: "employee-1" });
    const provider = { async authorizeSsh() { throw new Error("AWS ec2:authorize-security-group-ingress RulesPerSecurityGroupLimitExceeded"); } };
    assert.deepEqual((await applyAwsCpuSshAccess(db, provider, { id: jobId })).map((item) => item.status), ["failed"]);
    assert.match(listAwsCpuSshAccess(db, jobId)[0].error, /RulesPerSecurityGroupLimitExceeded/);
  } finally { db.close(); }
});

function readyJob(db, id, state = "ready", extra = {}) {
  db.prepare(`INSERT INTO run_box_job (id, decision_id, project_id, provider, profile_id, state, repo_url, max_duration_minutes,
    stop_requested_at, created_at, updated_at) VALUES (@id, @id, 'project-1', 'aws-ec2', 'aws-cpu', @state, 'https://example.com/r',
    60, @stop, @at, @at)`).run({ id, state, stop: extra.stop ?? null, at: new Date().toISOString() });
}

test("HAC-166: the worker applies pending desktop addresses for ready jobs only and records failures", async () => {
  const db = database();
  const ready = "55555555-5555-4555-8555-555555555555";
  const broken = "66666666-6666-4666-8666-666666666666";
  const verifying = "77777777-7777-4777-8777-777777777777";
  const stopping = "88888888-8888-4888-8888-888888888888";
  try {
    readyJob(db, ready);
    readyJob(db, broken);
    readyJob(db, verifying, "verifying");
    readyJob(db, stopping, "ready", { stop: new Date().toISOString() });
    for (const id of [ready, broken, verifying, stopping])
      requestAwsCpuSshAccess(db, { jobId: id, cidr: "8.8.8.8/32", employeeId: "employee-1", source: "desktop" });
    const calls = [];
    const provider = {
      async authorizeSsh(job, cidr) {
        calls.push(job.id);
        if (job.id === broken) throw new Error("AWS RulesPerSecurityGroupLimitExceeded");
        return { ruleId: "sgr-0aa", cidr };
      },
    };
    const outcomes = await applyReadyAwsCpuSshAccess(db, provider);
    assert.deepEqual(calls.sort(), [ready, broken].sort());
    assert.deepEqual(outcomes.map((item) => [item.jobId, item.status]).sort(), [[broken, "failed"], [ready, "applied"]].sort());
    assert.equal(listAwsCpuSshAccess(db, ready)[0].status, "applied");
    assert.equal(listAwsCpuSshAccess(db, broken)[0].status, "failed");
    assert.match(listAwsCpuSshAccess(db, broken)[0].error, /RulesPerSecurityGroupLimitExceeded/);
    assert.equal(listAwsCpuSshAccess(db, verifying)[0].status, "pending");
    assert.equal(listAwsCpuSshAccess(db, stopping)[0].status, "pending");
    // Nothing left to do: no provider calls on the next cycle.
    await applyReadyAwsCpuSshAccess(db, provider);
    assert.equal(calls.length, 2);
    // A failed address can be requested again.
    assert.equal(requestAwsCpuSshAccess(db, { jobId: broken, cidr: "8.8.8.8/32", employeeId: "employee-1", source: "desktop" }).status, "pending");
  } finally { db.close(); }
});

test("HAC-166: a replaced address is revoked by the worker unless it is the worker's own", async () => {
  const db = database();
  const id = "55555555-5555-4555-8555-555555555555";
  try {
    readyJob(db, id);
    const provider = {
      revoked: [],
      async authorizeSsh(_job, cidr) { return { ruleId: "sgr-0aa", cidr }; },
      async revokeSshCidr(_job, cidr) { this.revoked.push(cidr); return ["sgr-0aa"]; },
    };
    const addresses = ["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9"];
    for (const [index, ip] of addresses.entries())
      requestAwsCpuSshAccess(db, { jobId: id, cidr: `${ip}/32`, employeeId: "employee-1", source: "desktop", now: new Date(Date.UTC(2026, 8, 26, 12, index)) });
    await applyAwsCpuSshAccess(db, provider, { id }, { keepCidr: "8.8.4.4/32" });
    requestAwsCpuSshAccess(db, { jobId: id, cidr: "4.4.4.4/32", employeeId: "employee-1", source: "desktop", now: new Date(Date.UTC(2026, 8, 26, 13)) });
    requestAwsCpuSshAccess(db, { jobId: id, cidr: "4.2.2.2/32", employeeId: "employee-1", source: "desktop", now: new Date(Date.UTC(2026, 8, 26, 14)) });
    const status = () => Object.fromEntries(listAwsCpuSshAccess(db, id).map((row) => [row.cidr, row.status]));
    assert.equal(status()["8.8.8.8/32"], "replaced");
    assert.equal(status()["8.8.4.4/32"], "replaced");
    await applyAwsCpuSshAccess(db, provider, { id }, { keepCidr: "8.8.4.4/32" });
    assert.deepEqual(provider.revoked, ["8.8.8.8/32"]);
    assert.equal(status()["8.8.8.8/32"], "revoked");
    assert.equal(status()["8.8.4.4/32"], "revoked");
    assert.equal(Object.values(status()).filter((value) => value === "applied").length, MAX_REQUESTER_CIDRS);
    // A pending address that is replaced never reached AWS and is revoked at once.
    for (const [index, ip] of ["2.2.2.2", "3.3.3.3", "5.5.5.5", "6.6.6.6", "7.7.7.7", "11.11.11.11"].entries())
      requestAwsCpuSshAccess(db, { jobId: id, cidr: `${ip}/32`, employeeId: "employee-1", source: "desktop", now: new Date(Date.UTC(2026, 8, 26, 15, index)) });
    assert.equal(status()["2.2.2.2/32"], "revoked");
  } finally { db.close(); }
});

test("HAC-166: the first-version table is migrated to accept desktop requests", () => {
  const db = database();
  try {
    db.exec(`CREATE TABLE aws_cpu_ssh_access (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES run_box_job(id), cidr TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('create', 'refresh')), requested_by TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'applied', 'failed')), rule_id TEXT, error TEXT, created_at TEXT NOT NULL,
      last_requested_at TEXT NOT NULL, applied_at TEXT, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX aws_cpu_ssh_access_active ON aws_cpu_ssh_access(job_id, cidr) WHERE status IN ('pending', 'applied');`);
    requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.8.8/32", employeeId: "employee-1" });
    requestAwsCpuSshAccess(db, { jobId, cidr: "8.8.4.4/32", employeeId: "employee-1", source: "desktop" });
    assert.deepEqual(listAwsCpuSshAccess(db, jobId).map((row) => row.source), ["create", "desktop"]);
    assert.throws(() => db.prepare(`INSERT INTO aws_cpu_ssh_access (id, job_id, cidr, source, requested_by, status, created_at,
      last_requested_at, updated_at) VALUES ('x', ?, '8.8.8.8/32', 'desktop', 'e', 'pending', 'a', 'a', 'a')`).run(jobId), /UNIQUE/);
  } finally { db.close(); }
});
